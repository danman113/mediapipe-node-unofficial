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

import {FileLocator, WasmMediaPipeConstructor} from './graph_runner_factory_api';
import {NodeCanvas} from './node_canvas';
import {isProfileEnabled, profileNow, recordPhase} from './node_profile';
import {WasmModule} from './wasm_module';

// Subset of the wasm bridge the Node-side image-input shim needs. The full
// types are owned by the various GraphRunner mixins; we just declare the
// few symbols we touch directly so this file remains an ambient type-island.
interface NodeWasmBridge {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  _addRgbaImageToInputStream(
    dataPtr: number, width: number, height: number,
    streamNamePtr: number, timestamp: number): void;
  _addBoundTextureAsImageToStream?:
      (streamNamePtr: number, width: number, height: number,
       timestamp: number) => void;
}

// Node-side counterpart to `createMediaPipeLib` in `graph_runner.ts`. The
// browser path uses `runScript` to inject a `<script>` tag and pulls
// `self.ModuleFactory` out of the global scope; under Node we instead
// `require()` the Emscripten loader directly and read the `.wasm` payload
// off disk.

type ModuleFactory = (locator: FileLocator) => Promise<WasmModule>;

interface NodeFileSystem {
  readFileSync(path: string): Uint8Array;
}

function loadFs(): NodeFileSystem {
  // tslint:disable-next-line:no-require-imports
  return require('fs') as NodeFileSystem;
}

function ensureGlobalSelf(): void {
  // Emscripten's loader frequently references `self`. Map it onto
  // `globalThis` if it isn't already present.
  const g = globalThis as unknown as {self?: unknown};
  if (g.self === undefined) g.self = globalThis;
}

function loadModuleFactory(loaderPath: string): ModuleFactory {
  ensureGlobalSelf();

  // Capture any `self.ModuleFactory` that may already be set so we can
  // restore it afterward (avoid leaking state between loads).
  const g = globalThis as unknown as {ModuleFactory?: ModuleFactory};
  const previous = g.ModuleFactory;
  g.ModuleFactory = undefined;

  // tslint:disable-next-line:no-require-imports
  const required = require(loaderPath) as ModuleFactory |
      {default?: ModuleFactory; ModuleFactory?: ModuleFactory};

  let factory: ModuleFactory | undefined;
  if (typeof required === 'function') {
    factory = required;
  } else if (required && typeof required === 'object') {
    factory = required.default ?? required.ModuleFactory;
  }
  // Some Emscripten builds emit a UMD wrapper that assigns the factory to
  // `self.ModuleFactory` rather than returning it from `require`.
  if (!factory && g.ModuleFactory) {
    factory = g.ModuleFactory;
  }

  g.ModuleFactory = previous;

  if (!factory) {
    throw new Error(
        'Could not resolve a ModuleFactory from ' + loaderPath +
        '. Expected the Emscripten loader to export a factory function.');
  }
  return factory;
}

/**
 * Node-side equivalent of `createMediaPipeLib` from `graph_runner.ts`.
 * Bypasses the browser `<script>`-tag loader: requires the Emscripten loader
 * JS via Node's module resolver and reads the wasm binary off disk.
 */
export async function createMediaPipeLibNode<LibType>(
    constructorFcn: WasmMediaPipeConstructor<LibType>,
    wasmLoaderPath: string,
    wasmBinaryPath: string,
    glCanvas: NodeCanvas,
    ): Promise<LibType> {
  const factory = loadModuleFactory(wasmLoaderPath);
  const fs = loadFs();
  const wasmBinary = fs.readFileSync(wasmBinaryPath);

  const locator: FileLocator & {
    wasmBinary?: Uint8Array;
    canvas?: unknown;
    noInitialRun?: boolean;
    print?: (msg: string) => void;
    printErr?: (msg: string) => void;
  } = {
    locateFile(file: string): string {
      if (file.endsWith('.wasm')) return wasmBinaryPath;
      return file;
    },
    wasmBinary,
    canvas: glCanvas,
    noInitialRun: true,
    // Surface Emscripten warnings; suppress when the test wants them quiet.
    print(msg: string) {
      // tslint:disable-next-line:no-console
      console.log(msg);
    },
    printErr(msg: string) {
      // tslint:disable-next-line:no-console
      console.error(msg);
    },
  };

  const module = await factory(locator);
  installImageInputShim(module as unknown as NodeWasmBridge, glCanvas);
  return new constructorFcn(module, glCanvas as unknown as HTMLCanvasElement);
}

/**
 * Replaces `wasmModule._addBoundTextureAsImageToStream` with a JS shim that
 * consumes the `lastImageSource` that `node_canvas.ts` cached during the
 * preceding `texImage2D` call, copies the RGBA pixels into wasm memory, and
 * routes them through `_addRgbaImageToInputStream` (a CPU-backed Image
 * input). The browser path uploads the texture and the C++ side reads it
 * back via Emscripten's GL bridge — that round-trip doesn't work under
 * headless-gl, so we bypass the GL texture entirely under Node.
 */
function installImageInputShim(
    wasmBridge: NodeWasmBridge, canvas: NodeCanvas): void {
  if (typeof wasmBridge._addRgbaImageToInputStream !== 'function') {
    throw new Error(
        '_addRgbaImageToInputStream is not exported from the wasm module. ' +
        'The @mediapipe/tasks-vision-node bundle requires a Node-built ' +
        'vision_wasm_internal.js with the graph_runner_internal.cc bridge.');
  }
  wasmBridge._addBoundTextureAsImageToStream =
      (streamNamePtr: number, width: number, height: number,
       timestamp: number) => {
        const source = canvas.lastImageSource;
        if (!source) {
          throw new Error(
              'No image source was captured by NodeCanvas before ' +
              '_addBoundTextureAsImageToStream fired. Was texImage2D ' +
              'called via bindTextureToStream?');
        }
        const expectedLen = width * height * 4;
        if (source.data.length < expectedLen) {
          throw new Error(
              'Captured image source is smaller than expected: have ' +
              `${source.data.length} bytes, need ${expectedLen} for ` +
              `${width}x${height} RGBA.`);
        }
        const profiling = isProfileEnabled();
        const tMalloc = profiling ? profileNow() : 0;
        const dataPtr = wasmBridge._malloc(expectedLen);
        if (profiling) recordPhase('shim.malloc', tMalloc);
        try {
          const tCopy = profiling ? profileNow() : 0;
          wasmBridge.HEAPU8.set(
              source.data.subarray(0, expectedLen), dataPtr);
          if (profiling) recordPhase('shim.heapCopy', tCopy);
          const tPush = profiling ? profileNow() : 0;
          wasmBridge._addRgbaImageToInputStream(
              dataPtr, width, height, streamNamePtr, timestamp);
          if (profiling) recordPhase('shim.wasmPush', tPush);
        } finally {
          const tFree = profiling ? profileNow() : 0;
          wasmBridge._free(dataPtr);
          if (profiling) recordPhase('shim.free', tFree);
        }
      };
}
