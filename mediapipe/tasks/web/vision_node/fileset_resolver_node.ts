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

import {WasmFileset} from '../../../tasks/web/core/wasm_fileset';

// Node-friendly counterpart to `FilesetResolver.forVisionTasks(jsdelivrPath)`.
// The browser flow expects an HTTP URL prefix; under Node we expect a local
// directory containing the upstream-prebuilt wasm + loader files. The user
// can either point at the `wasm/` directory inside an installed
// `@mediapipe/tasks-vision-node` (default) or override with a custom path.

const DEFAULT_RELATIVE_WASM_DIR = 'wasm';

interface PathLike {
  isAbsolute(p: string): boolean;
  join(...segments: string[]): string;
  resolve(...segments: string[]): string;
}

interface NodeFs {
  existsSync(path: string): boolean;
}

function loadPath(): PathLike {
  // tslint:disable-next-line:no-require-imports
  return require('path') as PathLike;
}

function loadFs(): NodeFs {
  // tslint:disable-next-line:no-require-imports
  return require('fs') as NodeFs;
}

function defaultWasmDir(): string {
  const path = loadPath();
  // __dirname is set by CommonJS; fall back to cwd if running under ESM.
  const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  return path.join(here, DEFAULT_RELATIVE_WASM_DIR);
}

/** Minimal sibling of `FilesetResolver` for Node consumers. */
export class FilesetResolverNode {
  /**
   * Returns a {@link WasmFileset} suitable for vision tasks under Node. If
   * `wasmDir` is omitted, defaults to the `wasm/` directory shipped inside
   * the installed `@mediapipe/tasks-vision-node` package.
   */
  static forVisionTasks(wasmDir?: string): Promise<WasmFileset> {
    const path = loadPath();
    const fs = loadFs();
    const dir = wasmDir ? path.resolve(wasmDir) : defaultWasmDir();

    // Stage 1 ships the upstream-prebuilt SIMD bundle. The non-SIMD variant
    // is not currently relevant under Node since Node has SIMD on every
    // supported version.
    const wasmLoaderPath = path.join(dir, 'vision_wasm_internal.js');
    const wasmBinaryPath = path.join(dir, 'vision_wasm_internal.wasm');

    if (!fs.existsSync(wasmLoaderPath) || !fs.existsSync(wasmBinaryPath)) {
      return Promise.reject(new Error(
          `FilesetResolverNode.forVisionTasks: expected vision_wasm_internal.js ` +
          `and vision_wasm_internal.wasm under ${dir}`));
    }

    return Promise.resolve({
      wasmLoaderPath,
      wasmBinaryPath,
    });
  }
}
