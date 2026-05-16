// Copyright 2026 danman113.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

#include "mediapipe/web/graph_runner/node_inference_config.h"

namespace mediapipe {
namespace web {

namespace {
int g_xnnpack_num_threads_override = -1;
}  // namespace

int GetNodeXnnpackNumThreadsOverride() {
  return g_xnnpack_num_threads_override;
}

void SetNodeXnnpackNumThreadsOverride(int n) {
  g_xnnpack_num_threads_override = n;
}

}  // namespace web
}  // namespace mediapipe
