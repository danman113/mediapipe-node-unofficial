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

#ifndef MEDIAPIPE_CALCULATORS_TENSOR_IMAGE_TO_TENSOR_CONVERTER_BASIC_CPU_H_
#define MEDIAPIPE_CALCULATORS_TENSOR_IMAGE_TO_TENSOR_CONVERTER_BASIC_CPU_H_

#include <memory>

#include "mediapipe/calculators/tensor/image_to_tensor_converter.h"
#include "mediapipe/calculators/tensor/image_to_tensor_utils.h"
#include "mediapipe/framework/calculator_framework.h"
#include "mediapipe/framework/formats/tensor.h"
#include "mediapipe/framework/port/statusor.h"

namespace mediapipe {

// Hand-rolled CPU image-to-tensor converter for builds where neither
// OpenCV nor Halide is available (notably the @mediapipe/tasks-vision-node
// wasm build). Implements rotated-rect crop + bilinear resize + value-range
// remap for SRGB / SRGBA / GRAY8 inputs into float32 / uint8 / int8 tensors.
//
// Lower throughput than the OpenCV path; fine for inference at task-runner
// frame rates but not optimized.
absl::StatusOr<std::unique_ptr<ImageToTensorConverter>>
CreateBasicCpuConverter(CalculatorContext* cc, BorderMode border_mode,
                        Tensor::ElementType tensor_type);

}  // namespace mediapipe

#endif  // MEDIAPIPE_CALCULATORS_TENSOR_IMAGE_TO_TENSOR_CONVERTER_BASIC_CPU_H_
