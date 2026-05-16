// Native single-threaded perf baseline for hand_landmarker. Built with the
// existing C API so we can compare against the WASM `@danman113/mediapipe-node`
// build and decide whether a native N-API addon (Tier 9) would deliver a
// meaningful speedup or whether the WASM ceiling is already close to native.
//
// Usage:
//   bazel build -c opt --define MEDIAPIPE_DISABLE_GPU=1 \
//     //mediapipe/tasks/c/vision/hand_landmarker:native_perf_bench
//   ./bazel-bin/.../native_perf_bench <model.task> <image.jpg> [warmup] [runs]
//
// Reports min/p50/p95/p99/max/throughput, single-thread, no I/O in the timed
// loop (image is decoded once up front and reused).

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "mediapipe/tasks/c/core/base_options.h"
#include "mediapipe/tasks/c/vision/core/image.h"
#include "mediapipe/tasks/c/vision/hand_landmarker/hand_landmarker.h"
#include "mediapipe/tasks/c/vision/hand_landmarker/hand_landmarker_result.h"

namespace {

double NowMs() {
  using clock = std::chrono::steady_clock;
  return std::chrono::duration<double, std::milli>(
             clock::now().time_since_epoch())
      .count();
}

struct Stats {
  double min, max, mean, p50, p95, p99;
  size_t n;
};

Stats Compute(std::vector<double> v) {
  std::sort(v.begin(), v.end());
  Stats s;
  s.n = v.size();
  s.min = v.front();
  s.max = v.back();
  double sum = 0;
  for (double x : v) sum += x;
  s.mean = sum / v.size();
  auto pct = [&](double p) {
    size_t i = static_cast<size_t>(p * v.size());
    if (i >= v.size()) i = v.size() - 1;
    return v[i];
  };
  s.p50 = pct(0.50);
  s.p95 = pct(0.95);
  s.p99 = pct(0.99);
  return s;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr,
            "usage: %s <model.task> <image.jpg> [warmup=10] [runs=100]\n",
            argv[0]);
    return 64;
  }
  const char* model_path = argv[1];
  const char* image_path = argv[2];
  const int warmup = (argc > 3) ? atoi(argv[3]) : 10;
  const int runs = (argc > 4) ? atoi(argv[4]) : 100;

  HandLandmarkerOptions options{};
  options.base_options.model_asset_path = model_path;
  options.base_options.delegate = CPU;
  options.running_mode = IMAGE;
  options.num_hands = 2;
  options.min_hand_detection_confidence = 0.5f;
  options.min_hand_presence_confidence = 0.5f;
  options.min_tracking_confidence = 0.5f;

  char* err = nullptr;
  MpHandLandmarkerPtr lm = nullptr;
  if (MpHandLandmarkerCreate(&options, &lm, &err) != kMpOk) {
    fprintf(stderr, "create failed: %s\n", err ? err : "(no message)");
    free(err);
    return 1;
  }

  MpImagePtr image = nullptr;
  err = nullptr;
  if (MpImageCreateFromFile(image_path, &image, &err) != kMpOk) {
    fprintf(stderr, "image load failed: %s\n", err ? err : "(no message)");
    free(err);
    MpHandLandmarkerClose(lm, nullptr);
    return 1;
  }

  fprintf(stderr, "Warmup (%d frames) …\n", warmup);
  for (int i = 0; i < warmup; ++i) {
    HandLandmarkerResult result{};
    err = nullptr;
    if (MpHandLandmarkerDetectImage(lm, image, nullptr, &result, &err) !=
        kMpOk) {
      fprintf(stderr, "detect failed: %s\n", err ? err : "(no message)");
      free(err);
      MpImageFree(image);
      MpHandLandmarkerClose(lm, nullptr);
      return 1;
    }
    MpHandLandmarkerCloseResult(&result);
  }

  fprintf(stderr, "Measuring (%d frames) …\n", runs);
  std::vector<double> timings;
  timings.reserve(runs);
  double wall_t0 = NowMs();
  for (int i = 0; i < runs; ++i) {
    HandLandmarkerResult result{};
    err = nullptr;
    double t0 = NowMs();
    if (MpHandLandmarkerDetectImage(lm, image, nullptr, &result, &err) !=
        kMpOk) {
      fprintf(stderr, "detect failed: %s\n", err ? err : "(no message)");
      free(err);
      MpImageFree(image);
      MpHandLandmarkerClose(lm, nullptr);
      return 1;
    }
    timings.push_back(NowMs() - t0);
    MpHandLandmarkerCloseResult(&result);
  }
  double wall_ms = NowMs() - wall_t0;

  MpImageFree(image);
  MpHandLandmarkerClose(lm, nullptr);

  Stats s = Compute(std::move(timings));
  double throughput = s.n / (wall_ms / 1000.0);

  printf("\n");
  printf("─────────────────────────────────────────────\n");
  printf("native single-thread baseline\n");
  printf("frames       : %zu\n", s.n);
  printf("warmup       : %d\n", warmup);
  printf("─────────────────────────────────────────────\n");
  printf("min          : %.2fms\n", s.min);
  printf("max          : %.2fms\n", s.max);
  printf("mean         : %.2fms\n", s.mean);
  printf("p50          : %.2fms\n", s.p50);
  printf("p95          : %.2fms\n", s.p95);
  printf("p99          : %.2fms\n", s.p99);
  printf("throughput   : %.1f fps\n", throughput);
  printf("wall time    : %.2fs\n", wall_ms / 1000.0);
  printf("─────────────────────────────────────────────\n");
  return 0;
}
