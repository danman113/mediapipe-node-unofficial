import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import alias from '@rollup/plugin-alias';
import terser from '@rollup/plugin-terser';

// Rollup config for the @mediapipe/tasks-vision-node bundle. Mirrors the
// browser config at //mediapipe/tasks/web:rollup.config.mjs, with two
// differences:
//
//   1. `platform_utils` is aliased to `platform_node`, so the bundled
//      output never references `navigator` / `OffscreenCanvas` / `self`.
//   2. Native peer deps (`gl`, `canvas`, `fs`, `path`) are externalized so
//      Node's resolver loads them from the host install rather than
//      bundling them.

export default {
  treeshake: false,
  external: ['gl', 'canvas', 'fs', 'path'],
  plugins: [
    alias({
      // The browser code does `import … from '…/platform_utils'`. After
      // mediapipe_ts_library compiles to JS, the import resolves to a
      // `.js` file in `bazel-bin`. Rewrite the basename so the same
      // import lands on `…/platform_node.js` instead, keeping the
      // relative directory path intact.
      entries: [{
        find: /platform_utils$/,
        // Explicit `.js` so rollup doesn't try to load a bare path.
        replacement: 'platform_node.js',
      }],
    }),
    resolve({preferBuiltins: true}),
    // `node_module_loader.ts` calls `require(loaderPath)` where the path
    // is the runtime-supplied wasm loader. Don't rewrite dynamic requires
    // — let Node resolve them at runtime.
    commonjs({ignoreDynamicRequires: true}),
    terser(),
  ],
};
