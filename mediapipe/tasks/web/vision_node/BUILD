# MediaPipe Vision Tasks — Node.js target (Stage 2).
#
# Builds a `@mediapipe/tasks-vision-node` package that links a
# source-compiled vision_wasm_internal.{js,wasm} (from emcc + the C++
# bridge in //mediapipe/web/graph_runner:graph_runner_internal_cc) and
# runs it under Node via the TS infrastructure put in place during
# Stage 1 (headless-gl, node-canvas, fs-backed loader).

load("//mediapipe/framework/port:build_config.bzl", "ts_library")
load("//mediapipe/tasks/web:build_defs.bzl", "pkg_npm", "rollup_bundle")
load(
    "//mediapipe/framework/tool:emscripten_cc_binary.bzl",
    "emscripten_cc_binary",
)
package(default_visibility = ["//mediapipe/tasks:internal"])

# Source-built WASM for the Node target — links the C++ bridge from
# //mediapipe/web/graph_runner with hand_landmarker's graph + calculators.
emscripten_cc_binary(
    name = "vision_wasm_internal",
    target_compatible_with = ["@platforms//cpu:wasm32"],
    deps = [
        "//mediapipe/tasks/cc/vision/hand_landmarker:hand_landmarker_graph",
        "//mediapipe/web/graph_runner:graph_runner_internal_cc",
    ],
)

# Copy the source-built artifacts into the `wasm/` subdirectory so the
# packaged npm layout matches what `FilesetResolverNode.forVisionTasks`
# resolves to (`wasm/vision_wasm_internal.{js,wasm}`).
genrule(
    name = "vision_wasm_internal_files",
    srcs = [":vision_wasm_internal"],
    outs = [
        "wasm/vision_wasm_internal.js",
        "wasm/vision_wasm_internal.wasm",
    ],
    cmd = (
        "for f in $(SRCS); do " +
        "  base=$$(basename $$f); " +
        "  cp $$f $(GENDIR)/mediapipe/tasks/web/vision_node/wasm/$$base; " +
        "done"
    ),
)

VISION_NODE_LIBS = [
    "//mediapipe/tasks/web/core:fileset_resolver",
    "//mediapipe/tasks/web/vision/hand_landmarker",
    "//mediapipe/web/graph_runner:node_canvas",
    "//mediapipe/web/graph_runner:node_module_loader",
    # Pulled in for the rollup alias step. Not imported from any .ts in
    # this package; the dep ensures `platform_node.js` is materialized in
    # `bazel-bin` so rollup can resolve `platform_utils` → `platform_node`.
    "//mediapipe/web/graph_runner:platform_node",
]

ts_library(
    name = "vision_node_lib",
    srcs = [
        "fileset_resolver_node.ts",
        "hand_landmarker_node.ts",
        "image_adapter.ts",
        "index.ts",
    ],
    visibility = ["//visibility:public"],
    deps = VISION_NODE_LIBS,
)

rollup_bundle(
    name = "vision_node_bundle_mjs",
    config_file = "rollup.config.mjs",
    entry_point = "index.ts",
    format = "esm",
    output_dir = False,
    sourcemap = "true",
    deps = [
        ":vision_node_lib",
        "//:node_modules/@rollup/plugin-commonjs",
        "//:node_modules/@rollup/plugin-node-resolve",
        "//:node_modules/@rollup/plugin-terser",
        "//:node_modules/google-protobuf",
    ],
)

rollup_bundle(
    name = "vision_node_bundle_cjs",
    config_file = "rollup.config.mjs",
    entry_point = "index.ts",
    format = "cjs",
    output_dir = False,
    sourcemap = "true",
    deps = [
        ":vision_node_lib",
        "//:node_modules/@rollup/plugin-commonjs",
        "//:node_modules/@rollup/plugin-node-resolve",
        "//:node_modules/@rollup/plugin-terser",
        "//:node_modules/google-protobuf",
    ],
)

genrule(
    name = "vision_node_sources",
    srcs = [
        ":vision_node_bundle_cjs",
        ":vision_node_bundle_mjs",
    ],
    outs = [
        "tasks-vision-node.cjs",
        "tasks-vision-node.cjs.map",
        "tasks-vision-node.mjs",
        "tasks-vision-node.mjs.map",
    ],
    cmd = (
        "for FILE in $(SRCS); do " +
        "  OUT_FILE=$(GENDIR)/mediapipe/tasks/web/vision_node/$$(" +
        "      basename $$FILE | sed -E 's/_([cm])js\\.js/.\\1js/' | " +
        "      sed -E 's/^vision_node_bundle/tasks-vision-node/'" +
        "  ); " +
        "  cp $$FILE $$OUT_FILE ; " +
        "done;"
    ),
)

pkg_npm(
    name = "vision_node_pkg",
    package_json = "package.json",
    srcs = ["README.md"],
    deps = [
        ":vision_node_sources",
        ":vision_wasm_internal_files",
    ],
)
