"""Bazel macro that produces a `.wasm` + `.js` pair from a cc_binary.

Wraps `@emsdk//emscripten_toolchain:wasm_rules.bzl%wasm_cc_binary` with
the linker flags MediaPipe's Node-side runtime expects (modularized,
WebGL2, growable memory, etc.). Used by the
`@mediapipe/tasks-vision-node` build to produce a source-compiled
`vision_wasm_node_internal.{js,wasm}`.
"""

load("@emsdk//emscripten_toolchain:wasm_rules.bzl", "wasm_cc_binary")
load("@rules_cc//cc:defs.bzl", "cc_binary")

# Common Emscripten linker flags. Kept in one place so callers can
# override / extend without re-listing the boilerplate.
_DEFAULT_LINKOPTS = [
    "-sMODULARIZE=1",
    "-sEXPORT_NAME=ModuleFactory",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sUSE_WEBGL2=1",
    "-sFULL_ES3=1",
    "-sMAX_WEBGL_VERSION=2",
    "-sINITIAL_MEMORY=256MB",
    "-sSTACK_SIZE=5MB",
    "-sEXPORTED_RUNTIME_METHODS=GL,ccall,cwrap,FS_createDataFile,FS_unlink,HEAPU8,HEAPU32,HEAPF32,HEAPF64,stringToNewUTF8",
    # Allow our extern "C" exports.
    "-sEXPORTED_FUNCTIONS=_malloc,_free",
    # Threads ON. Combined with `threads = "emscripten"` on wasm_cc_binary
    # below this propagates `-pthread` to every transitive compile + link
    # action via the use_pthreads toolchain feature, so the entire static
    # link agrees on the atomics ABI. PTHREAD_POOL_SIZE matches the upper
    # bound of GetCpuDefaultNumThreads(); XNNPack self-clamps to fewer.
    "-sUSE_PTHREADS=1",
    "-sPTHREAD_POOL_SIZE=4",
    # Don't dynamically resize the wasm memory mid-run from a thread; it
    # bombs out with multi-thread access in some emsdk versions and we
    # already pre-allocate 256MB above which is enough for hand_landmarker.
    "-Wno-pthreads-mem-growth",
    # absl's mutex deadlock detector calls __builtin_return_address /
    # GetStackTrace during graph initialization. Without the offset
    # converter Emscripten aborts the program before our error path runs.
    "-sUSE_OFFSET_CONVERTER=1",
    # Don't use WASM_BIGINT — the TS side (graph_runner.ts) passes
    # int64 timestamps as regular JS numbers, not BigInts. Emscripten's
    # legacy i64-as-double ABI accepts that.
    # Optimization: full wasm-opt pass + strip runtime assertions.
    "-O3",
    "-sASSERTIONS=0",
]

# wasm_cc_binary's internal transition does NOT forward --copt flags from
# .bazelrc into the WASM compilation context. These copts are embedded
# directly in the cc_binary rule so they survive the transition.
_DEFAULT_COPTS = [
    "-O3",       # clang: optimize all C++ compiled for wasm
    "-msimd128", # enable wasm SIMD v1; exposes __wasm_simd128__ define
]

def emscripten_cc_binary(
        name,
        srcs = [],
        deps = [],
        linkopts = [],
        copts = [],
        **kwargs):
    """Produce a `.wasm` + `.js` Emscripten artifact.

    Args:
      name: Target base name. Outputs are `{name}.js` and `{name}.wasm`.
      srcs: C++ source files (forwarded to cc_binary).
      deps: cc_library dependencies to link in.
      linkopts: Extra emcc linker flags appended after the defaults.
      copts: Compile flags forwarded to cc_binary.
      **kwargs: Forwarded to cc_binary (e.g. visibility).
    """
    cc_target_name = name + "_cc"

    cc_binary(
        name = cc_target_name + ".js",
        srcs = srcs,
        deps = deps,
        linkopts = _DEFAULT_LINKOPTS + linkopts,
        copts = _DEFAULT_COPTS + copts,
        **kwargs
    )

    wasm_cc_binary(
        name = name,
        cc_target = ":" + cc_target_name + ".js",
        # simd=True + backend="llvm" activates the "wasm_simd" toolchain feature
        # which adds -msimd128 to ALL transitive compilations (XNNPack, TFLite, …)
        # via the configuration transition — unlike copts which only affect the
        # binary's own srcs.
        simd = True,
        backend = "llvm",
        # threads="emscripten" activates the use_pthreads toolchain feature
        # which appends `-pthread` to every transitive compile + link, so
        # mediapipe core, XNNPack, TFLite, abseil, etc. all get atomics
        # support. Without this the link rejects pthread-using objects mixed
        # with non-atomics objects.
        threads = "emscripten",
        outputs = [
            name + ".js",
            name + ".wasm",
        ],
        visibility = kwargs.get("visibility"),
    )

# Note on relaxed-SIMD: enabling the toolchain feature `wasm_relaxed_simd`
# adds `-msimd128 -mrelaxed-simd` to ALL transitive compile + link actions
# (the requires-llvm_backend feature in the emsdk toolchain). XNNPack's
# relaxed-SIMD kernels gain ~10% over base SIMD. Activated by callers via
# `--features=wasm_relaxed_simd` on the bazel command line (dev_smoke.js
# wires this in behind a `--relaxed-simd` flag) so the default package stays
# Node 18 / older-Chrome compatible. The Node runtime currently needs
# `--experimental-wasm-relaxed-simd` on Node 20; Node 22+ has it stable.
