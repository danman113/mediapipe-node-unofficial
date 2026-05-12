// Copyright 2026 danman113.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "mediapipe/calculators/tensor/image_to_tensor_converter_basic_cpu.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

#include "absl/status/status.h"
#include "absl/strings/str_cat.h"
#include "mediapipe/calculators/tensor/image_to_tensor_converter.h"
#include "mediapipe/calculators/tensor/image_to_tensor_utils.h"
#include "mediapipe/framework/calculator_framework.h"
#include "mediapipe/framework/formats/image.h"
#include "mediapipe/framework/formats/image_format.pb.h"
#include "mediapipe/framework/formats/image_frame.h"
#include "mediapipe/framework/formats/tensor.h"
#include "mediapipe/framework/port/ret_check.h"
#include "mediapipe/framework/port/statusor.h"

namespace mediapipe {
namespace {

// Number of input bytes per pixel for each supported image format.
int InputChannelsForFormat(mediapipe::ImageFormat::Format format) {
  switch (format) {
    case mediapipe::ImageFormat::SRGB:
      return 3;
    case mediapipe::ImageFormat::SRGBA:
      return 4;
    case mediapipe::ImageFormat::GRAY8:
      return 1;
    default:
      return -1;
  }
}

class ImageToTensorBasicCpuConverter : public ImageToTensorConverter {
 public:
  ImageToTensorBasicCpuConverter(BorderMode border_mode,
                                 Tensor::ElementType tensor_type)
      : border_mode_(border_mode), tensor_type_(tensor_type) {}

  absl::Status Convert(const mediapipe::Image& input, const RotatedRect& roi,
                       float range_min, float range_max,
                       int tensor_buffer_offset,
                       Tensor& output_tensor) override {
    const int input_channels = InputChannelsForFormat(input.image_format());
    if (input_channels < 0) {
      return absl::InvalidArgumentError(absl::StrCat(
          "Unsupported input format: ",
          static_cast<uint32_t>(input.image_format())));
    }

    RET_CHECK_GE(tensor_buffer_offset, 0)
        << "tensor_buffer_offset must be non-negative.";
    const auto& shape = output_tensor.shape();
    MP_RETURN_IF_ERROR(ValidateTensorShape(shape));

    const int out_height = shape.dims[1];
    const int out_width = shape.dims[2];
    const int out_channels = shape.dims[3];
    if (out_channels != 1 && out_channels != 3) {
      return absl::InvalidArgumentError(absl::StrCat(
          "Unsupported output channel count: ", out_channels));
    }
    MP_RETURN_IF_ERROR(ValidateRoi(roi));

    auto image_frame = input.GetImageFrameSharedPtr();
    RET_CHECK(image_frame != nullptr) << "Image is not CPU-backed.";
    const uint8_t* src = image_frame->PixelData();
    const int src_width = image_frame->Width();
    const int src_height = image_frame->Height();
    const int src_step = image_frame->WidthStep();

    MP_ASSIGN_OR_RETURN(auto value_transform,
                        GetValueRangeTransformation(/*from_range_min=*/0.0f,
                                                    /*from_range_max=*/255.0f,
                                                    range_min, range_max));

    // Inverse affine map: output pixel (xd, yd) → source point (xs, ys).
    // Matches the GPU shader path: GetRotatedSubRectToRectTransformMatrix
    // uses [c, -d; d, c] for the rotation block, which corresponds to:
    //   local = ((xd - W/2) * roi.width / W, (yd - H/2) * roi.height / H)
    //   src.x = roi.center_x + cos(rotation) * lx - sin(rotation) * ly
    //   src.y = roi.center_y + sin(rotation) * lx + cos(rotation) * ly
    const float cos_t = std::cos(roi.rotation);
    const float sin_t = std::sin(roi.rotation);
    const float inv_w = roi.width / static_cast<float>(out_width);
    const float inv_h = roi.height / static_cast<float>(out_height);
    const float cx = roi.center_x;
    const float cy = roi.center_y;
    const float half_w = static_cast<float>(out_width) * 0.5f;
    const float half_h = static_cast<float>(out_height) * 0.5f;

    auto buffer_view = output_tensor.GetCpuWriteView();
    const int per_image_elements = out_height * out_width * out_channels;

    switch (tensor_type_) {
      case Tensor::ElementType::kFloat32: {
        RET_CHECK_GE(
            shape.num_elements(),
            tensor_buffer_offset / static_cast<int>(sizeof(float)) +
                per_image_elements)
            << "Tensor buffer offset + image size exceeds tensor capacity.";
        float* dst = buffer_view.buffer<float>() +
                     tensor_buffer_offset / sizeof(float);
        WriteAll<float>(src, src_width, src_height, src_step, input_channels,
                        out_width, out_height, out_channels, cos_t, sin_t,
                        inv_w, inv_h, cx, cy, half_w, half_h, value_transform,
                        dst);
        break;
      }
      case Tensor::ElementType::kUInt8: {
        RET_CHECK_GE(shape.num_elements(),
                     tensor_buffer_offset + per_image_elements)
            << "Tensor buffer offset + image size exceeds tensor capacity.";
        uint8_t* dst = buffer_view.buffer<uint8_t>() + tensor_buffer_offset;
        WriteAll<uint8_t>(src, src_width, src_height, src_step, input_channels,
                          out_width, out_height, out_channels, cos_t, sin_t,
                          inv_w, inv_h, cx, cy, half_w, half_h, value_transform,
                          dst);
        break;
      }
      case Tensor::ElementType::kInt8: {
        RET_CHECK_GE(shape.num_elements(),
                     tensor_buffer_offset + per_image_elements)
            << "Tensor buffer offset + image size exceeds tensor capacity.";
        int8_t* dst = buffer_view.buffer<int8_t>() + tensor_buffer_offset;
        WriteAll<int8_t>(src, src_width, src_height, src_step, input_channels,
                         out_width, out_height, out_channels, cos_t, sin_t,
                         inv_w, inv_h, cx, cy, half_w, half_h, value_transform,
                         dst);
        break;
      }
      default:
        return absl::InvalidArgumentError(absl::StrCat(
            "Unsupported tensor type: ", static_cast<int>(tensor_type_)));
    }
    return absl::OkStatus();
  }

 private:
  absl::Status ValidateTensorShape(const Tensor::Shape& shape) {
    RET_CHECK_EQ(shape.dims.size(), 4)
        << "Output tensor must be rank-4 (NHWC); got rank "
        << shape.dims.size();
    RET_CHECK_GE(shape.dims[0], 1) << "Batch dimension must be >= 1.";
    return absl::OkStatus();
  }

  // Read the channel value at integer (x, y) honoring border_mode_. Returns
  // 0 for out-of-bounds reads in kZero mode; clamps to nearest in-bounds for
  // kReplicate.
  inline float SamplePixel(const uint8_t* src, int src_width, int src_height,
                           int src_step, int input_channels, int x, int y,
                           int channel) const {
    if (border_mode_ == BorderMode::kReplicate) {
      x = std::clamp(x, 0, src_width - 1);
      y = std::clamp(y, 0, src_height - 1);
    } else if (x < 0 || x >= src_width || y < 0 || y >= src_height) {
      return 0.0f;
    }
    return static_cast<float>(src[y * src_step + x * input_channels + channel]);
  }

  // Bilinear sample at continuous (xs, ys) for a single channel.
  inline float Bilinear(const uint8_t* src, int src_width, int src_height,
                        int src_step, int input_channels, float xs, float ys,
                        int channel) const {
    const int x0 = static_cast<int>(std::floor(xs));
    const int y0 = static_cast<int>(std::floor(ys));
    const float fx = xs - x0;
    const float fy = ys - y0;
    const float p00 = SamplePixel(src, src_width, src_height, src_step,
                                  input_channels, x0, y0, channel);
    const float p10 = SamplePixel(src, src_width, src_height, src_step,
                                  input_channels, x0 + 1, y0, channel);
    const float p01 = SamplePixel(src, src_width, src_height, src_step,
                                  input_channels, x0, y0 + 1, channel);
    const float p11 = SamplePixel(src, src_width, src_height, src_step,
                                  input_channels, x0 + 1, y0 + 1, channel);
    const float top = p00 * (1.0f - fx) + p10 * fx;
    const float bottom = p01 * (1.0f - fx) + p11 * fx;
    return top * (1.0f - fy) + bottom * fy;
  }

  template <typename DstT>
  void WriteAll(const uint8_t* src, int src_width, int src_height,
                int src_step, int input_channels, int out_width, int out_height,
                int out_channels, float cos_t, float sin_t, float inv_w,
                float inv_h, float cx, float cy, float half_w, float half_h,
                ValueTransformation transform, DstT* dst) const {
    // Pixel-center sampling: dst pixel (xd, yd) is treated as the point
    // (xd + 0.5, yd + 0.5). This matches the GPU shader path, whose
    // texture_coordinate UV is interpolated to (xd+0.5)/W, (yd+0.5)/H. The
    // OpenCV CPU path uses pixel-corner alignment instead — they differ
    // by a half-pixel offset, but the GPU path is what hand_landmarker's
    // model was trained against.
    const int sample_channels = std::min(input_channels, out_channels);

#ifdef __wasm_simd128__
    // SIMD path: handle the common SRGBA-input → 3-channel-float-output case
    // (which is what hand_landmarker uses). Vectorizes the affine coordinate
    // computation and the value-range transform across 4 consecutive pixels per
    // iteration; bilinear fetch itself remains scalar (no wasm gather).
    if (std::is_same<DstT, float>::value && out_channels == 3 &&
        (input_channels == 3 || input_channels == 4) &&
        border_mode_ == BorderMode::kReplicate) {
      const v128_t v_scale = wasm_f32x4_splat(transform.scale);
      const v128_t v_offset = wasm_f32x4_splat(transform.offset);
      // Per-row: xs(xd) = xs_base + xs_step*xd, ys(xd) = ys_base + ys_step*xd
      const float xs_step = cos_t * inv_w;
      const float ys_step = sin_t * inv_w;
      // Offsets for 4 consecutive pixels: {0, 1, 2, 3} * step
      const v128_t v_steps_x =
          wasm_f32x4_make(0.f, xs_step, 2.f * xs_step, 3.f * xs_step);
      const v128_t v_steps_y =
          wasm_f32x4_make(0.f, ys_step, 2.f * ys_step, 3.f * ys_step);
      const int wide = out_width & ~3;  // round down to multiple of 4
      float* fdst = reinterpret_cast<float*>(dst);

      for (int yd = 0; yd < out_height; ++yd) {
        const float ly = (static_cast<float>(yd) + 0.5f - half_h) * inv_h;
        // Base xs/ys for xd=0 in this row.
        const float xs0 = cx + cos_t * ((0.5f - half_w) * inv_w) - sin_t * ly;
        const float ys0 = cy + sin_t * ((0.5f - half_w) * inv_w) + cos_t * ly;
        const v128_t v_xs0 = wasm_f32x4_splat(xs0);
        const v128_t v_ys0 = wasm_f32x4_splat(ys0);

        float* row_out = fdst + yd * out_width * 3;
        int xd = 0;
        for (; xd < wide; xd += 4) {
          // Compute source coordinates for 4 pixels at once.
          const v128_t v_xd = wasm_f32x4_make(
              static_cast<float>(xd), static_cast<float>(xd + 1),
              static_cast<float>(xd + 2), static_cast<float>(xd + 3));
          const v128_t v_xs =
              wasm_f32x4_add(v_xs0, wasm_f32x4_add(v_steps_x,
                  wasm_f32x4_mul(v_xd, wasm_f32x4_splat(xs_step))));
          const v128_t v_ys =
              wasm_f32x4_add(v_ys0, wasm_f32x4_add(v_steps_y,
                  wasm_f32x4_mul(v_xd, wasm_f32x4_splat(ys_step))));

          // Scalar bilinear fetch for each of the 4 pixels (3 channels each).
          float rgb[4][3];
          float xs_arr[4], ys_arr[4];
          wasm_v128_store(xs_arr, v_xs);
          wasm_v128_store(ys_arr, v_ys);
          for (int p = 0; p < 4; ++p) {
            for (int c = 0; c < 3; ++c) {
              const int sc = (c < input_channels) ? c : input_channels - 1;
              rgb[p][c] = Bilinear(src, src_width, src_height, src_step,
                                   input_channels, xs_arr[p], ys_arr[p], sc);
            }
          }

          // Interleave channels and apply value transform in SIMD.
          // Write 4 pixels × 3 channels = 12 floats.
          // R0 R1 R2 R3
          v128_t vr = wasm_f32x4_make(rgb[0][0], rgb[1][0], rgb[2][0], rgb[3][0]);
          v128_t vg = wasm_f32x4_make(rgb[0][1], rgb[1][1], rgb[2][1], rgb[3][1]);
          v128_t vb = wasm_f32x4_make(rgb[0][2], rgb[1][2], rgb[2][2], rgb[3][2]);
          vr = wasm_f32x4_add(wasm_f32x4_mul(vr, v_scale), v_offset);
          vg = wasm_f32x4_add(wasm_f32x4_mul(vg, v_scale), v_offset);
          vb = wasm_f32x4_add(wasm_f32x4_mul(vb, v_scale), v_offset);

          // De-interleave back to packed RGB: r0g0b0 r1g1b1 r2g2b2 r3g3b3
          float* p = row_out + xd * 3;
          float rr[4], gg[4], bb[4];
          wasm_v128_store(rr, vr);
          wasm_v128_store(gg, vg);
          wasm_v128_store(bb, vb);
          for (int i = 0; i < 4; ++i) {
            p[i * 3 + 0] = rr[i];
            p[i * 3 + 1] = gg[i];
            p[i * 3 + 2] = bb[i];
          }
        }
        // Scalar tail for remaining pixels (out_width % 4).
        for (; xd < out_width; ++xd) {
          const float lx = (static_cast<float>(xd) + 0.5f - half_w) * inv_w;
          const float xs = cx + cos_t * lx - sin_t * ly;
          const float ys = cy + sin_t * lx + cos_t * ly;
          float* p = row_out + xd * 3;
          for (int c = 0; c < 3; ++c) {
            const int sc = (c < sample_channels) ? c : sample_channels - 1;
            p[c] = Bilinear(src, src_width, src_height, src_step, input_channels,
                            xs, ys, sc) * transform.scale + transform.offset;
          }
        }
      }
      return;
    }
#endif  // __wasm_simd128__

    // Scalar fallback — all formats and types.
    for (int yd = 0; yd < out_height; ++yd) {
      const float ly = (static_cast<float>(yd) + 0.5f - half_h) * inv_h;
      for (int xd = 0; xd < out_width; ++xd) {
        const float lx = (static_cast<float>(xd) + 0.5f - half_w) * inv_w;
        const float xs = cx + cos_t * lx - sin_t * ly;
        const float ys = cy + sin_t * lx + cos_t * ly;
        DstT* out = dst + (yd * out_width + xd) * out_channels;
        for (int c = 0; c < out_channels; ++c) {
          float v;
          if (c < sample_channels) {
            v = Bilinear(src, src_width, src_height, src_step, input_channels,
                         xs, ys, c);
          } else {
            const int last = sample_channels - 1;
            v = Bilinear(src, src_width, src_height, src_step, input_channels,
                         xs, ys, last);
          }
          v = v * transform.scale + transform.offset;
          out[c] = SaturateCast<DstT>(v);
        }
      }
    }
  }

  template <typename T>
  static T SaturateCast(float v);

  BorderMode border_mode_;
  Tensor::ElementType tensor_type_;
};

template <>
float ImageToTensorBasicCpuConverter::SaturateCast<float>(float v) {
  return v;
}

template <>
uint8_t ImageToTensorBasicCpuConverter::SaturateCast<uint8_t>(float v) {
  v = std::round(v);
  if (v < 0.0f) return 0;
  if (v > 255.0f) return 255;
  return static_cast<uint8_t>(v);
}

template <>
int8_t ImageToTensorBasicCpuConverter::SaturateCast<int8_t>(float v) {
  v = std::round(v);
  if (v < -128.0f) return -128;
  if (v > 127.0f) return 127;
  return static_cast<int8_t>(v);
}

}  // namespace

absl::StatusOr<std::unique_ptr<ImageToTensorConverter>>
CreateBasicCpuConverter(CalculatorContext* /*cc*/, BorderMode border_mode,
                        Tensor::ElementType tensor_type) {
  if (tensor_type != Tensor::ElementType::kFloat32 &&
      tensor_type != Tensor::ElementType::kUInt8 &&
      tensor_type != Tensor::ElementType::kInt8) {
    return absl::InvalidArgumentError(
        absl::StrCat("Tensor type unsupported by basic CPU converter: ",
                     static_cast<int>(tensor_type)));
  }
  return std::make_unique<ImageToTensorBasicCpuConverter>(border_mode,
                                                          tensor_type);
}

}  // namespace mediapipe
