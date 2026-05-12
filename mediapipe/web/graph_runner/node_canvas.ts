/**
 * Copyright 2026 danman113.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Node-side stand-in for `HTMLCanvasElement` / `OffscreenCanvas`. Backed by
// `headless-gl` (npm `gl`) which gives us a real WebGL context against
// SwiftShader/OSMesa. The graph runner only uses `width`, `height`,
// `getContext('webgl2'|'webgl')`, and `addEventListener` from the canvas
// surface, so a duck-typed wrapper is sufficient.

// We avoid a direct `import` of `gl` so that this file can be type-checked
// without the optional peer dependency installed. The npm package is loaded
// at runtime via `require()`.
//
// Stage 1 caveat: `headless-gl` exposes WebGL1 entry points; the WebGL2
// surface is partial. The runtime gap (sync fences, etc.) is filled in
// by `installWebGL2Shim` from `node_webgl2_shim.ts`.

import {installWebGL2Shim} from './node_webgl2_shim';

interface HeadlessGLFactory {
  (
    width: number,
    height: number,
    options?: {
      preserveDrawingBuffer?: boolean;
      premultipliedAlpha?: boolean;
      antialias?: boolean;
    },
  ): WebGLRenderingContext | null;
}

let headlessGlFactory: HeadlessGLFactory | undefined;

function loadHeadlessGl(): HeadlessGLFactory {
  if (headlessGlFactory) return headlessGlFactory;
  // Use a runtime require so the rollup bundle leaves it as a peer import.
  // tslint:disable-next-line:no-require-imports
  const required = require('gl') as HeadlessGLFactory | {default: HeadlessGLFactory};
  headlessGlFactory =
      (typeof required === 'function' ? required : required.default);
  if (!headlessGlFactory) {
    throw new Error(
        'Failed to load `gl` (headless-gl). Install it as a peer dependency ' +
        'of @mediapipe/tasks-vision-node.');
  }
  return headlessGlFactory;
}

/** Captured pixel data from the most recent `texImage2D` upload. */
export interface CapturedImageSource {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Minimal HTMLCanvasElement-like wrapper around a headless-gl WebGL
 * context. The graph runner stores this on `wasmModule.canvas` and calls
 * `getContext('webgl2'|'webgl')` later — we hand back the same context
 * instance every time.
 */
export class NodeCanvas {
  // tslint:disable:enforce-name-casing
  width: number;
  height: number;
  // tslint:enable:enforce-name-casing

  private readonly gl: WebGLRenderingContext;

  // Most recent ImageData-shaped source passed to `texImage2D`. The Node
  // bundle's `_addBoundTextureAsImageToStream` override reads this to push
  // pixels into wasm via `_addRgbaImageToInputStream` instead of through a
  // GL texture (headless-gl can't share textures with Emscripten's GL).
  lastImageSource: CapturedImageSource | null = null;

  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
    const factory = loadHeadlessGl();
    const ctx = factory(width, height, {
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!ctx) {
      throw new Error('headless-gl returned no WebGL context.');
    }
    this.gl = ctx;
    // Backfill WebGL2 entry points MediaPipe's Emscripten glue calls.
    installWebGL2Shim(ctx);
    // Intercept the 6-arg `texImage2D(target, level, internalformat, format,
    // type, source)` form used by `graph_runner.ts#bindTextureToStream` so we
    // can stash the pixel buffer for the JS-side `_addBoundTextureAsImageToStream`
    // override. headless-gl doesn't support uploading from ImageData/Canvas
    // directly anyway, so swallowing this call is also necessary to avoid a
    // GL_INVALID_VALUE on the Node path.
    const canvasRef = this;
    const originalTexImage2D =
        (ctx.texImage2D as (...args: unknown[]) => void).bind(ctx);
    (ctx as unknown as {texImage2D: (...args: unknown[]) => void})
        .texImage2D = function(...args: unknown[]): void {
      if (args.length === 6) {
        const source = args[5] as {
          data?: Uint8Array | Uint8ClampedArray;
          width?: number;
          height?: number;
        } | null;
        if (source && source.data && source.width && source.height) {
          canvasRef.lastImageSource = {
            data: source.data,
            width: source.width,
            height: source.height,
          };
        }
        return;
      }
      originalTexImage2D(...args);
    };
    // Emscripten's WebGL glue references `WebGLRenderingContext` /
    // `WebGL2RenderingContext` as globals in two places:
    //   1. A `typeof WebGL2RenderingContext != "undefined"` check that
    //      decides whether to request a WebGL2 context (we want it to).
    //   2. A Safari-workaround that wraps `canvas.getContext` and rejects
    //      the result when `(ver == "webgl") == (gl instanceof
    //      WebGLRenderingContext)` mismatches.
    //
    // Strategy: WebGL2RenderingContext = the headless-gl constructor (so
    // `gl instanceof WebGL2RenderingContext` is true and the typeof
    // check passes); WebGLRenderingContext = an unrelated dummy class
    // (so `gl instanceof WebGLRenderingContext` is false, satisfying
    // the Safari check for the webgl2 branch). Pre-mark the canvas so
    // the workaround skips wrapping entirely — we don't have a Safari
    // bug to work around.
    const g = globalThis as unknown as {
      WebGLRenderingContext?: unknown;
      WebGL2RenderingContext?: unknown;
    };
    const ctor = (ctx as {constructor: unknown}).constructor;
    // Force MediaPipe down its WebGL1 fallback path. headless-gl is
    // GLES 2.0 / WebGL 1 only — the shaders MediaPipe compiles for
    // GLES 3.0 (`#version 300 es`, integer textures, transform
    // feedback) won't compile here, and a downstream call against a
    // null program ID surfaces as "table index is out of bounds" deep
    // in WASM. The WebGL1 path doesn't use those features and gets
    // past graph startup; the sync shim above handles its prod_token
    // requirement.
    if (g.WebGLRenderingContext === undefined) g.WebGLRenderingContext = ctor;
    // Intentionally do NOT define WebGL2RenderingContext —
    // Emscripten's `typeof WebGL2RenderingContext != 'undefined'`
    // check then picks majorVersion=1.
    // Mark this canvas so Emscripten's `getContextSafariWebGL2Fixed`
    // workaround is skipped — our getContext is already correct.
    (this as unknown as {getContextSafariWebGL2Fixed?: unknown})
        .getContextSafariWebGL2Fixed = this.getContext.bind(this);
  }

  getContext(type: 'webgl' | 'webgl2' | string): WebGLRenderingContext | null {
    // Return null for webgl2 explicitly — headless-gl is WebGL1, and
    // letting MediaPipe's gl_context_webgl.cc fall through to its
    // WebGL1 path is what actually works end-to-end. The sync-fence
    // shim handles the prod_token check on that path.
    if (type === 'webgl2') return null;
    if (type === 'webgl' || type === 'experimental-webgl') return this.gl;
    return null;
  }

  addEventListener(_type: string, _listener: unknown, _options?: unknown):
      void {}

  removeEventListener(_type: string, _listener: unknown, _options?: unknown):
      void {}

  /**
   * Releases the underlying WebGL context. Optional — most users let the
   * process exit handle cleanup.
   */
  dispose(): void {
    const ext = this.gl.getExtension('STACKGL_destroy_context') as
        ({destroy?: () => void} | null);
    if (ext && typeof ext.destroy === 'function') {
      ext.destroy();
    }
  }
}

/**
 * Factory equivalent of `document.createElement('canvas')` for Node. Used by
 * the platform indirection so the same code path that creates a backup canvas
 * in the browser produces a NodeCanvas under Node.
 */
export function createPlatformCanvas(): NodeCanvas {
  return new NodeCanvas();
}
