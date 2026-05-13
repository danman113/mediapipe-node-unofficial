import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

// Inline alias plugin: rewrites bare `…/platform_utils` imports to land on
// `…/platform_node.js` instead. Used in place of `@rollup/plugin-alias` so
// we don't add a new npm dep to the root workspace.
const platformUtilsAlias = {
  name: 'platform-utils-alias',
  async resolveId(source, importer, options) {
    if (!/platform_utils$/.test(source)) return null;
    const rewritten = source.replace(/platform_utils$/, 'platform_node.js');
    const resolved = await this.resolve(rewritten, importer, {
      ...options,
      skipSelf: true,
    });
    return resolved ?? rewritten;
  },
};

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
    platformUtilsAlias,
    resolve({preferBuiltins: true}),
    // `node_module_loader.ts` calls `require(loaderPath)` where the path
    // is the runtime-supplied wasm loader. Don't rewrite dynamic requires
    // — let Node resolve them at runtime.
    commonjs({ignoreDynamicRequires: true}),
    terser(),
  ],
};
