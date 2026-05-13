# The TypeScript graph runner used by all MediaPipe Web tasks.

load("//mediapipe/framework/port:build_config.bzl", "ts_declaration", "ts_library")
load("//mediapipe/tasks/web:build_defs.bzl", "jasmine_node_test")

# C++ side of the JS↔WASM bridge for the Node target. Implements the
# extern "C" exports declared in `wasm_module.d.ts`.
cc_library(
    name = "graph_runner_internal_cc",
    srcs = ["graph_runner_internal.cc"],
    target_compatible_with = ["@platforms//cpu:wasm32"],
    visibility = ["//mediapipe/tasks:internal"],
    alwayslink = True,
    deps = [
        "//mediapipe/framework:calculator_cc_proto",
        "//mediapipe/framework:calculator_framework",
        "//mediapipe/framework/formats:image",
        "//mediapipe/framework/formats:image_frame",
        "//mediapipe/framework/port:parse_text_proto",
        "//mediapipe/tasks/cc/core:mediapipe_builtin_op_resolver",
        "//mediapipe/tasks/cc/core:model_resources_cache",
        "@com_google_absl//absl/log:absl_check",
        "@com_google_absl//absl/log:absl_log",
        "@com_google_absl//absl/status",
    ],
)

package(default_visibility = [
    "//mediapipe/tasks:internal",
])

# Public types for GraphRunner listeners
ts_declaration(
    name = "listener_types",
    srcs = [
        "listener_types.d.ts",
    ],
    visibility = ["//visibility:private"],
)

# Public API for GraphRunner
ts_declaration(
    name = "graph_runner_api",
    srcs = [
        "graph_runner_api.d.ts",
    ],
    deps = [
        ":listener_types",
        ":wasm_module_private",
    ],
)

# Public API for GraphRunner creation factory functions
ts_library(
    name = "graph_runner_factory_api",
    srcs = [
        "graph_runner_factory_api.d.ts",
    ],
    deps = [
        ":graph_runner_api",
        ":wasm_module_private",
    ],
)

# Private declarations for the Wasm module
ts_declaration(
    name = "wasm_module_private",
    srcs = ["wasm_module.d.ts"],
    visibility = ["//visibility:private"],
    deps = [":listener_types"],
)

# Internal GraphRunner implementation
ts_library(
    name = "graph_runner_ts",
    srcs = [
        ":graph_runner.ts",
    ],
    allow_unoptimized_namespaces = True,
    deps = [
        ":graph_runner_api",
        ":graph_runner_factory_api",
        ":listener_types",
        ":platform_utils",
        ":run_script_helper",
        ":wasm_module_private",
    ],
)

ts_library(
    name = "graph_runner_image_lib_ts",
    srcs = [
        ":graph_runner_image_lib.ts",
    ],
    allow_unoptimized_namespaces = True,
    deps = [":graph_runner_ts"],
)

ts_library(
    name = "register_model_resources_graph_service_ts",
    srcs = [
        ":register_model_resources_graph_service.ts",
    ],
    allow_unoptimized_namespaces = True,
    deps = [":graph_runner_ts"],
)

ts_library(
    name = "platform_utils",
    srcs = [
        "platform_utils.ts",
    ],
)

# Node-only stand-in for `platform_utils`. Aliased into the
# @mediapipe/tasks-vision-node bundle by its rollup config.
ts_library(
    name = "platform_node",
    srcs = [
        "platform_node.ts",
    ],
    visibility = ["//mediapipe/tasks:internal"],
)

# Stubs for WebGL2 entry points missing from headless-gl. Mutates the gl
# context in place so Emscripten's WebGL glue can call them.
ts_library(
    name = "node_webgl2_shim",
    srcs = [
        "node_webgl2_shim.ts",
    ],
    allow_unoptimized_namespaces = True,
    visibility = ["//mediapipe/tasks:internal"],
)

# HTMLCanvasElement-like wrapper around headless-gl, used by the Node bundle.
ts_library(
    name = "node_canvas",
    srcs = [
        "node_canvas.ts",
    ],
    allow_unoptimized_namespaces = True,
    visibility = ["//mediapipe/tasks:internal"],
    deps = [
        ":node_webgl2_shim",
    ],
)

# fs-backed counterpart to `createMediaPipeLib`.
ts_library(
    name = "node_module_loader",
    srcs = [
        "node_module_loader.ts",
    ],
    allow_unoptimized_namespaces = True,
    visibility = ["//mediapipe/tasks:internal"],
    deps = [
        ":graph_runner_factory_api",
        ":node_canvas",
        ":wasm_module_private",
    ],
)

ts_library(
    name = "platform_utils_test_lib",
    testonly = True,
    srcs = [
        "platform_utils.test.ts",
    ],
    deps = [":platform_utils"],
)

genrule(
    name = "run_script_genrule",
    srcs = ["run_script_helper.ts.template"],
    outs = ["run_script_helper.ts"],
    cmd = "cp $< $@",
)

ts_library(
    name = "run_script_helper",
    srcs = ["run_script_helper.ts"],
)

jasmine_node_test(
    name = "platform_utils_test",
    srcs = [
        ":platform_utils_test_lib",
    ],
)

ts_library(
    name = "graph_runner_webgpu_ts",
    srcs = [
        "graph_runner_webgpu.ts",
    ],
    allow_unoptimized_namespaces = True,
    deps = [
        ":graph_runner_ts",
    ],
)

ts_library(
    name = "graph_runner_wasm_file_reference_ts",
    srcs = [
        "graph_runner_wasm_file_reference.ts",
    ],
    allow_unoptimized_namespaces = True,
    deps = [
        ":graph_runner_ts",
    ],
)

ts_library(
    name = "graph_runner_streaming_reader_ts",
    srcs = [
        "graph_runner_streaming_reader.ts",
    ],
    allow_unoptimized_namespaces = True,
    deps = [
        ":graph_runner_ts",
    ],
)

ts_library(
    name = "graph_runner_llm_inference_lib_ts",
    srcs = [
        "graph_runner_llm_inference_lib.ts",
    ],
    allow_unoptimized_namespaces = True,
    deps = [
        ":graph_runner_streaming_reader_ts",
        ":graph_runner_ts",
        "//mediapipe/tasks/web/genai/llm_inference:llm_inference_types",
        "//mediapipe/tasks/web/genai/llm_inference:model_loading_utils",
        "//mediapipe/tasks/web/genai/llm_inference/proto:llm_inference_graph_options_jspb_proto",
        "//mediapipe/tasks/web/genai/llm_inference/proto:sampler_params_jspb_proto",
    ],
)
