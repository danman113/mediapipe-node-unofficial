// Copyright 2026 danman113.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// C++ side of the JS↔WASM bridge that
// `mediapipe/web/graph_runner/graph_runner.ts` relies on. Re-implemented
// from scratch since the upstream-prebuilt's bridge is in Google-internal
// source. The contract is `wasm_module.d.ts`. Coverage in this revision
// is the subset hand_landmarker uses; expand as smoke-test failures
// surface missing functions.

#include <emscripten/emscripten.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "absl/log/absl_check.h"
#include "absl/log/absl_log.h"
#include "absl/status/status.h"
#include "mediapipe/framework/calculator.pb.h"
#include "mediapipe/framework/calculator_graph.h"
#include "mediapipe/framework/formats/image.h"
#include "mediapipe/framework/formats/image_frame.h"
#include "mediapipe/framework/packet.h"
#include "mediapipe/framework/port/parse_text_proto.h"
#include "mediapipe/framework/timestamp.h"
#include "libyuv/convert_argb.h"
#include "libyuv/video_common.h"
#include "mediapipe/tasks/cc/core/mediapipe_builtin_op_resolver.h"
#include "mediapipe/tasks/cc/core/model_resources_cache.h"
#include "mediapipe/web/graph_runner/node_inference_config.h"

namespace mediapipe {
namespace web {
namespace {

// Singleton graph state owned by the WASM module. The TS side assumes a
// single CalculatorGraph per WASM instance (`graph_runner.ts`'s
// `setGraph` replaces the current graph). We follow that contract.
class GraphRunnerState {
 public:
  static GraphRunnerState& Get() {
    static GraphRunnerState* singleton = new GraphRunnerState();
    return *singleton;
  }

  CalculatorGraph& graph() { return graph_; }

  // Listener-attach helpers. The TS side calls `_attachProtoListener` /
  // `_attachProtoVectorListener` *before* `_changeBinaryGraph`, but
  // `CalculatorGraph::ObserveOutputStream` requires the graph to have
  // been Initialized first. Buffer the requests and replay them inside
  // SetGraph() after Initialize() succeeds.
  enum class ListenerKind { kProto, kVectorProto };
  void RememberListener(const std::string& stream_name, ListenerKind kind) {
    pending_listeners_.push_back({stream_name, kind});
  }

  // Resets the graph and starts running it with the supplied config.
  // `binary` indicates whether `data`/`size` is a serialized
  // CalculatorGraphConfig proto (true) or a textproto (false).
  absl::Status SetGraph(const uint8_t* data, size_t size, bool binary) {
    // Close any existing graph cleanly before swapping.
    if (graph_started_) {
      auto status = graph_.CloseAllPacketSources();
      if (status.ok()) status = graph_.WaitUntilDone();
      if (!status.ok()) {
        ABSL_LOG(WARNING) << "Closing previous graph failed: " << status;
      }
      graph_started_ = false;
    }

    CalculatorGraphConfig config;
    if (binary) {
      if (!config.ParseFromArray(data, static_cast<int>(size))) {
        return absl::InvalidArgumentError(
            "Failed to parse binary CalculatorGraphConfig");
      }
    } else {
      std::string text(reinterpret_cast<const char*>(data), size);
      if (!ParseTextProto<CalculatorGraphConfig>(text, &config)) {
        return absl::InvalidArgumentError(
            "Failed to parse textproto CalculatorGraphConfig");
      }
    }
    last_config_ = config;

    // Tasks-vision graphs require the ModelResourcesCacheService to be
    // available before Initialize() runs. The TS-side calls
    // `_registerModelResourcesGraphService` ahead of `setGraph`; that
    // sets a flag we honor here.
    if (model_resources_cache_requested_) {
      auto cache = std::make_shared<tasks::core::ModelResourcesCache>(
          std::make_unique<tasks::core::MediaPipeBuiltinOpResolver>());
      auto svc_status = graph_.SetServiceObject(
          tasks::core::kModelResourcesCacheService, std::move(cache));
      if (!svc_status.ok()) return svc_status;
    }

    auto init_status = graph_.Initialize(config);
    if (!init_status.ok()) return init_status;

    // Replay listeners that the TS side requested before setGraph fired.
    // (CalculatorGraph::ObserveOutputStream requires Initialize() first.)
    for (const auto& [name, kind] : pending_listeners_) {
      auto status = AttachListenerImpl(name, kind);
      if (!status.ok()) return status;
    }
    pending_listeners_.clear();

    return absl::OkStatus();
  }

  void RequestModelResourcesCacheService() {
    model_resources_cache_requested_ = true;
  }

  // Lazily start the graph the first time we need to push input.
  absl::Status EnsureStarted() {
    if (graph_started_) return absl::OkStatus();
    auto status = graph_.StartRun(side_packets_);
    if (status.ok()) graph_started_ = true;
    return status;
  }

  absl::Status WaitUntilIdle() {
    auto status = EnsureStarted();
    if (!status.ok()) return status;
    return graph_.WaitUntilIdle();
  }

  absl::Status Close() {
    if (!graph_started_) return absl::OkStatus();
    auto status = graph_.CloseAllPacketSources();
    if (status.ok()) status = graph_.WaitUntilDone();
    graph_started_ = false;
    return status;
  }

  // Side packets must be added before StartRun(); we accumulate them.
  void AddSidePacket(const std::string& name, Packet packet) {
    side_packets_[name] = std::move(packet);
  }

  // Cached last-applied config so `_getGraphConfig` can return it.
  const CalculatorGraphConfig& last_config() const { return last_config_; }

  void set_auto_render_to_screen(bool enabled) {
    auto_render_to_screen_ = enabled;
  }

 private:
  GraphRunnerState() = default;

  // Installs an output-stream observer on `graph_`. Defined out-of-line
  // below the EM_JS helpers so it can call them.
  absl::Status AttachListenerImpl(const std::string& stream_name,
                                  ListenerKind kind);

  CalculatorGraph graph_;
  bool graph_started_ = false;
  bool model_resources_cache_requested_ = false;
  std::map<std::string, Packet> side_packets_;
  CalculatorGraphConfig last_config_;
  bool auto_render_to_screen_ = false;
  std::vector<std::pair<std::string, ListenerKind>> pending_listeners_;
};

// Shared helper: serialize bytes into a JS-side dispatch into
// `Module.simpleListeners[stream_name]`. Two payload shapes:
//   - 3-arg form (data, done, timestamp): used by *VectorListener; this
//     helper emits the per-element call. Caller must also emit a final
//     done=true call to flush the buffer.
//   - 2-arg form (data, timestamp): used by single-packet listeners.
//
// `kind == 0`: single-packet (calls listener(data, ts)).
// `kind == 1`: vector element (calls listener(data, false, ts)).
// `kind == 2`: vector done (calls listener(null, true, ts)).
// Emscripten's EM_JS doesn't reliably handle int64_t parameters when the
// build is linked without `-sWASM_BIGINT`: the wasm ABI splits an i64 into
// two i32 args, but EM_JS's JS body only references it positionally as one
// name, so any params *after* an i64 get shifted by one and read garbage.
// Workaround: take timestamps as `double` here and have callers cast at
// the call site. Doubles round-trip int64 microseconds safely up to 2^53.
EM_JS(void, MpEmitListenerCall,
      (const char* stream_name, const uint8_t* data, size_t size,
       double timestamp_us, int kind),
      {
        // clang-format off
        var name = UTF8ToString(stream_name);
        var listener = Module.simpleListeners && Module.simpleListeners[name];
        if (!listener) return;
        if (kind === 2) {
          listener(null, true, timestamp_us);
          return;
        }
        // The wasm buffer the listener receives must outlive this call —
        // for vector listeners (kind=1) the TS side buffers it and only
        // dispatches on the kind=2 flush. Take an owned copy via slice()
        // so the data survives subsequent serialize calls and any wasm
        // allocator activity between now and the flush.
        var bytes = HEAPU8.slice(data, data + size);
        if (kind === 1) {
          listener(bytes, false, timestamp_us);
        } else {
          listener(bytes, timestamp_us);
        }
        // clang-format on
      });

EM_JS(void, MpEmitEmptyPacketCall,
      (const char* stream_name, double timestamp_us),
      {
        // clang-format off
        var name = UTF8ToString(stream_name);
        var listener = Module.emptyPacketListeners &&
                       Module.emptyPacketListeners[name];
        if (listener) listener(timestamp_us);
        // clang-format on
      });

EM_JS(void, MpEmitErrorCall,
      (int code, const char* message),
      {
        // clang-format off
        var listener = Module.errorListener;
        if (listener) listener(code, UTF8ToString(message));
        // clang-format on
      });

template <typename T>
absl::Status PushPacket(const std::string& stream_name, T value,
                        int64_t timestamp_us) {
  auto& state = GraphRunnerState::Get();
  auto status = state.EnsureStarted();
  if (!status.ok()) return status;
  return state.graph().AddPacketToInputStream(
      stream_name,
      MakePacket<T>(std::move(value)).At(Timestamp(timestamp_us)));
}

void ReportStatus(const absl::Status& status) {
  if (status.ok()) return;
  ABSL_LOG(ERROR) << status;
  MpEmitErrorCall(static_cast<int>(status.code()),
                  std::string(status.message()).c_str());
}

absl::Status GraphRunnerState::AttachListenerImpl(
    const std::string& stream_name, ListenerKind kind) {
  std::string name_copy = stream_name;
  if (kind == ListenerKind::kProto) {
    return graph_.ObserveOutputStream(
        stream_name,
        [name_copy](const Packet& packet) -> absl::Status {
          if (packet.IsEmpty()) {
            MpEmitEmptyPacketCall(name_copy.c_str(),
                                  packet.Timestamp().Microseconds());
            return absl::OkStatus();
          }
          const auto& message = packet.GetProtoMessageLite();
          std::string serialized;
          message.SerializeToString(&serialized);
          MpEmitListenerCall(
              name_copy.c_str(),
              reinterpret_cast<const uint8_t*>(serialized.data()),
              serialized.size(), packet.Timestamp().Microseconds(),
              /*kind=*/0);
          return absl::OkStatus();
        });
  }
  // kVectorProto: emit one call per element with kind=1, then a final
  // flush call with kind=2 so the TS-side vector listener drains.
  return graph_.ObserveOutputStream(
      stream_name,
      [name_copy](const Packet& packet) -> absl::Status {
        if (packet.IsEmpty()) {
          MpEmitEmptyPacketCall(name_copy.c_str(),
                                packet.Timestamp().Microseconds());
          return absl::OkStatus();
        }
        const auto& items = packet.GetVectorOfProtoMessageLitePtrs();
        if (!items.ok()) return items.status();
        const int64_t ts = packet.Timestamp().Microseconds();
        for (const auto* item : *items) {
          std::string serialized;
          item->SerializeToString(&serialized);
          MpEmitListenerCall(
              name_copy.c_str(),
              reinterpret_cast<const uint8_t*>(serialized.data()),
              serialized.size(), ts, /*kind=*/1);
        }
        MpEmitListenerCall(name_copy.c_str(), nullptr, 0, ts, /*kind=*/2);
        return absl::OkStatus();
      });
}

}  // namespace
}  // namespace web
}  // namespace mediapipe

using mediapipe::Packet;
using mediapipe::Timestamp;
using mediapipe::web::GraphRunnerState;
using mediapipe::web::MpEmitEmptyPacketCall;
using mediapipe::web::MpEmitListenerCall;
using mediapipe::web::PushPacket;
using mediapipe::web::ReportStatus;

extern "C" {

EMSCRIPTEN_KEEPALIVE void changeBinaryGraph(int size, const uint8_t* data) {
  ReportStatus(GraphRunnerState::Get().SetGraph(data, size, /*binary=*/true));
}

EMSCRIPTEN_KEEPALIVE void changeTextGraph(int size, const uint8_t* data) {
  ReportStatus(GraphRunnerState::Get().SetGraph(data, size, /*binary=*/false));
}

EMSCRIPTEN_KEEPALIVE void closeGraph() {
  ReportStatus(GraphRunnerState::Get().Close());
}

EMSCRIPTEN_KEEPALIVE void waitUntilIdle() {
  ReportStatus(GraphRunnerState::Get().WaitUntilIdle());
}

EMSCRIPTEN_KEEPALIVE void setAutoRenderToScreen(bool enabled) {
  GraphRunnerState::Get().set_auto_render_to_screen(enabled);
}

EMSCRIPTEN_KEEPALIVE void registerModelResourcesGraphService() {
  GraphRunnerState::Get().RequestModelResourcesCacheService();
}

// Override the XNNPack interpreter thread count read by
// `inference_interpreter_delegate_runner.cc`. Must be called *before*
// `_changeBinaryGraph` so the inference calculator's first
// `SetNumThreads` sees the override. Pass <=0 to revert to the default
// (4 under `__EMSCRIPTEN_PTHREADS__`). Useful for fork-pool callers who
// want to tune threads-per-fork.
EMSCRIPTEN_KEEPALIVE void setNodeXnnpackNumThreads(int n) {
  mediapipe::web::SetNodeXnnpackNumThreadsOverride(n);
}

// YUV → RGBA conversion via libyuv. JS-side `decodeYuvBuffer` plumbs the
// detector's wasm heap into here so the conversion runs as SIMD-vectorized
// native code inside wasm (way faster than a pure-JS conversion loop, on
// the order of 0.5-1ms for 720p vs 10-30ms in JS).
//
// `fourcc` follows libyuv's FourCC scheme:
//   0x3231564E = "NV12" (Y plane + interleaved UV; ffmpeg default for h264 decode)
//   0x30323449 = "I420" (Y, U, V planar; common from FFmpeg `-pix_fmt yuv420p`)
//
// Plane stride args mirror libyuv's conventions:
//   - NV12: y_stride = Y row stride, u_stride = UV interleaved row stride
//           (= width for 4:2:0), v_plane/v_stride unused (pass nullptr/0).
//   - I420: y_stride = width, u_stride = v_stride = width/2.
//
// `rgba_out` must point to `width * height * 4` bytes, byte order R,G,B,A
// (matches what node-canvas's `ctx.getImageData` returns and what
// `_addRgbaImageToInputStream` expects).
EMSCRIPTEN_KEEPALIVE int yuvToRgba(const uint8_t* y_plane, int y_stride,
                                    const uint8_t* u_plane, int u_stride,
                                    const uint8_t* v_plane, int v_stride,
                                    int width, int height, int fourcc,
                                    uint8_t* rgba_out) {
  if (width <= 0 || height <= 0) return -1;
  const int rgba_stride = width * 4;
  switch (fourcc) {
    case libyuv::FOURCC_NV12:
      // libyuv's *ABGR functions emit byte order R,G,B,A (Windows GDI
      // labels this "ABGR" because little-endian uint32 reads it that way).
      // That's what we actually need on the JS side.
      return libyuv::NV12ToABGR(y_plane, y_stride, u_plane, u_stride,
                                rgba_out, rgba_stride, width, height);
    case libyuv::FOURCC_NV21:
      return libyuv::NV21ToABGR(y_plane, y_stride, u_plane, u_stride,
                                rgba_out, rgba_stride, width, height);
    case libyuv::FOURCC_I420:
      return libyuv::I420ToABGR(y_plane, y_stride, u_plane, u_stride,
                                v_plane, v_stride, rgba_out, rgba_stride,
                                width, height);
    default:
      return -2;  // unsupported fourcc
  }
}

// Stubs for the GL-texture image input path. The Node bundle replaces
// `_addBoundTextureAsImageToStream` with a JS shim that routes to
// `_addRgbaImageToInputStream`; these symbols only need to exist for
// the `wasmImageModule` interface to type-check.
EMSCRIPTEN_KEEPALIVE void bindTextureToStream(const char* /*stream*/) {}

EMSCRIPTEN_KEEPALIVE void addBoundTextureAsImageToStream(
    const char* /*stream*/, int /*width*/, int /*height*/, int64_t /*ts*/) {
  // No-op fallback. The Node-side override should always fire first.
  ABSL_LOG(WARNING)
      << "addBoundTextureAsImageToStream invoked without Node-side override";
}

// CPU image input — Node-only, used by the @mediapipe/tasks-vision-node
// runtime. The browser path uploads an HTML/Offscreen canvas frame to a
// WebGL texture and pushes it via `_addBoundTextureAsImageToStream`.
// Headless-gl can't share textures with Emscripten's GL context, so the
// Node bundle copies pixels into wasm memory and we wrap them in a
// CPU-backed mediapipe::Image instead.
EMSCRIPTEN_KEEPALIVE void addRgbaImageToInputStream(const uint8_t* data,
                                                    int width, int height,
                                                    const char* stream,
                                                    int64_t ts) {
  auto& state = GraphRunnerState::Get();
  auto status = state.EnsureStarted();
  if (!status.ok()) {
    ReportStatus(status);
    return;
  }
  const int width_step = width * 4;
  auto image_frame = std::make_shared<mediapipe::ImageFrame>(
      mediapipe::ImageFormat::SRGBA, width, height,
      mediapipe::ImageFrame::kDefaultAlignmentBoundary);
  // node-canvas hands us a tightly packed RGBA buffer. When the ImageFrame's
  // padded WidthStep matches width*4 (true for any width that is a multiple
  // of `kDefaultAlignmentBoundary / 4` = 4, which covers ~every real video
  // resolution: 640, 1280, 1920, …), the row-by-row copy degenerates into
  // one large memcpy. Detect that and skip the loop overhead.
  if (image_frame->WidthStep() == width_step) {
    std::memcpy(image_frame->MutablePixelData(), data,
                static_cast<size_t>(width_step) * height);
  } else {
    for (int y = 0; y < height; ++y) {
      std::memcpy(image_frame->MutablePixelData() + y * image_frame->WidthStep(),
                  data + y * width_step, width_step);
    }
  }
  mediapipe::Image image(std::move(image_frame));
  ReportStatus(state.graph().AddPacketToInputStream(
      stream,
      mediapipe::MakePacket<mediapipe::Image>(std::move(image))
          .At(Timestamp(ts))));
}

// Scalar input streams.
EMSCRIPTEN_KEEPALIVE void addBoolToInputStream(bool data, const char* stream,
                                               int64_t ts) {
  ReportStatus(PushPacket<bool>(stream, data, ts));
}
EMSCRIPTEN_KEEPALIVE void addIntToInputStream(int32_t data, const char* stream,
                                              int64_t ts) {
  ReportStatus(PushPacket<int>(stream, data, ts));
}
EMSCRIPTEN_KEEPALIVE void addUintToInputStream(uint32_t data,
                                               const char* stream, int64_t ts) {
  ReportStatus(PushPacket<uint32_t>(stream, data, ts));
}
EMSCRIPTEN_KEEPALIVE void addFloatToInputStream(float data, const char* stream,
                                                int64_t ts) {
  ReportStatus(PushPacket<float>(stream, data, ts));
}
EMSCRIPTEN_KEEPALIVE void addDoubleToInputStream(double data,
                                                 const char* stream,
                                                 int64_t ts) {
  ReportStatus(PushPacket<double>(stream, data, ts));
}
EMSCRIPTEN_KEEPALIVE void addStringToInputStream(const char* data,
                                                 const char* stream,
                                                 int64_t ts) {
  ReportStatus(PushPacket<std::string>(stream, std::string(data), ts));
}

EMSCRIPTEN_KEEPALIVE void addEmptyPacketToInputStream(const char* stream,
                                                     int64_t ts) {
  auto& state = GraphRunnerState::Get();
  auto status = state.EnsureStarted();
  if (status.ok()) {
    status = state.graph().AddPacketToInputStream(
        stream, Packet().At(Timestamp(ts)));
  }
  ReportStatus(status);
}

// Proto input — `proto_type` is the fully-qualified message name; the
// payload is its serialized wire format. We use `PacketFromDynamicProto`
// so the resulting Packet carries the *typed* proto (not generic
// bytes), which is what the receiving calculators expect.
EMSCRIPTEN_KEEPALIVE void addProtoToInputStream(const uint8_t* data, int size,
                                               const char* proto_type,
                                               const char* stream,
                                               int64_t ts) {
  std::string bytes(reinterpret_cast<const char*>(data), size);
  auto& state = GraphRunnerState::Get();
  auto status = state.EnsureStarted();
  if (!status.ok()) {
    ReportStatus(status);
    return;
  }
  auto packet_or = mediapipe::packet_internal::PacketFromDynamicProto(
      proto_type, bytes);
  if (!packet_or.ok()) {
    ReportStatus(packet_or.status());
    return;
  }
  ReportStatus(state.graph().AddPacketToInputStream(
      stream, std::move(*packet_or).At(Timestamp(ts))));
}

EMSCRIPTEN_KEEPALIVE void addProtoToInputSidePacket(const uint8_t* data,
                                                  int size,
                                                  const char* proto_type,
                                                  const char* stream) {
  std::string bytes(reinterpret_cast<const char*>(data), size);
  auto packet_or = mediapipe::packet_internal::PacketFromDynamicProto(
      proto_type, bytes);
  if (!packet_or.ok()) {
    ReportStatus(packet_or.status());
    return;
  }
  GraphRunnerState::Get().AddSidePacket(stream, std::move(*packet_or));
}

EMSCRIPTEN_KEEPALIVE void addBoolToInputSidePacket(bool data,
                                                  const char* stream) {
  GraphRunnerState::Get().AddSidePacket(stream, mediapipe::MakePacket<bool>(data));
}
EMSCRIPTEN_KEEPALIVE void addIntToInputSidePacket(int32_t data,
                                                 const char* stream) {
  GraphRunnerState::Get().AddSidePacket(stream, mediapipe::MakePacket<int>(data));
}
EMSCRIPTEN_KEEPALIVE void addUintToInputSidePacket(uint32_t data,
                                                  const char* stream) {
  GraphRunnerState::Get().AddSidePacket(stream,
                                        mediapipe::MakePacket<uint32_t>(data));
}
EMSCRIPTEN_KEEPALIVE void addFloatToInputSidePacket(float data,
                                                   const char* stream) {
  GraphRunnerState::Get().AddSidePacket(stream,
                                        mediapipe::MakePacket<float>(data));
}
EMSCRIPTEN_KEEPALIVE void addDoubleToInputSidePacket(double data,
                                                    const char* stream) {
  GraphRunnerState::Get().AddSidePacket(stream,
                                        mediapipe::MakePacket<double>(data));
}
EMSCRIPTEN_KEEPALIVE void addStringToInputSidePacket(const char* data,
                                                    const char* stream) {
  GraphRunnerState::Get().AddSidePacket(
      stream, mediapipe::MakePacket<std::string>(std::string(data)));
}

// Output stream listeners.

EMSCRIPTEN_KEEPALIVE void attachProtoListener(const char* stream,
                                              bool /*deep_copy*/) {
  GraphRunnerState::Get().RememberListener(
      stream, GraphRunnerState::ListenerKind::kProto);
}

EMSCRIPTEN_KEEPALIVE void attachProtoVectorListener(const char* stream,
                                                    bool /*deep_copy*/) {
  GraphRunnerState::Get().RememberListener(
      stream, GraphRunnerState::ListenerKind::kVectorProto);
}

// Returns the running graph's CalculatorGraphConfig via the
// CALCULATOR_GRAPH_CONFIG_LISTENER_NAME listener. Used by tasks/web/core
// to read back the config for inspection.
EMSCRIPTEN_KEEPALIVE void getGraphConfig(const char* listener_name,
                                         bool /*deep_copy*/) {
  std::string serialized;
  GraphRunnerState::Get().last_config().SerializeToString(&serialized);
  MpEmitListenerCall(listener_name,
                     reinterpret_cast<const uint8_t*>(serialized.data()),
                     serialized.size(), /*ts=*/0, /*kind=*/0);
}

}  // extern "C"
