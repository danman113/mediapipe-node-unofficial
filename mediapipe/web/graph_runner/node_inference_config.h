// Copyright 2026 danman113.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Process-wide knobs the @danman113/mediapipe-node JS API can flip from
// outside before the calculator graph initializes. Currently:
//
//   - XNNPack thread count override (replaces the hardcoded `4` default
//     from `inference_interpreter_delegate_runner.cc` so callers can tune
//     threads-per-fork in worker-pool setups).
//
// Read-mostly state, set during init only, accessed from inference setup.
// Plain `int` is fine — Emscripten with USE_PTHREADS=1 still has a single
// JS event loop and these globals are only mutated from that loop.

#ifndef MEDIAPIPE_WEB_GRAPH_RUNNER_NODE_INFERENCE_CONFIG_H_
#define MEDIAPIPE_WEB_GRAPH_RUNNER_NODE_INFERENCE_CONFIG_H_

namespace mediapipe {
namespace web {

// -1 → use the runtime default (which is `4` under
// `__EMSCRIPTEN_PTHREADS__`). Positive values override.
int GetNodeXnnpackNumThreadsOverride();
void SetNodeXnnpackNumThreadsOverride(int n);

}  // namespace web
}  // namespace mediapipe

#endif  // MEDIAPIPE_WEB_GRAPH_RUNNER_NODE_INFERENCE_CONFIG_H_
