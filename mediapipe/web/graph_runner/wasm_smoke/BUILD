load("//mediapipe/framework/tool:emscripten_cc_binary.bzl", "emscripten_cc_binary")

emscripten_cc_binary(
    name = "hello_wasm",
    srcs = ["hello.cc"],
    target_compatible_with = ["@platforms//cpu:wasm32"],
    visibility = ["//mediapipe/tasks:internal"],
)
