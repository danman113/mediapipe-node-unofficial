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
import {HandLandmarker} from '../../../tasks/web/vision/hand_landmarker/hand_landmarker';
import {NodeCanvas} from '../../../web/graph_runner/node_canvas';
import {createMediaPipeLibNode} from '../../../web/graph_runner/node_module_loader';

import type {HandLandmarkerOptions} from '../../../tasks/web/vision/hand_landmarker/hand_landmarker_options';

/** Node-only options layered on top of the upstream HandLandmarkerOptions. */
export interface HandLandmarkerNodeOptions extends HandLandmarkerOptions {
  /**
   * XNNPack thread count for inference. Defaults to 4. Set to 1 for
   * single-thread mode (useful when running many forks in a worker pool —
   * each fork wants fewer threads to avoid oversubscribing CPU cores).
   * <=0 means "use the runtime default" (4).
   */
  numThreads?: number;
}

// The setter is exported from the C++ bridge as `_setNodeXnnpackNumThreads`.
// Declared as an optional method so older WASM builds without this symbol
// still type-check (we just skip the call).
interface WasmModuleWithThreadOverride {
  _setNodeXnnpackNumThreads?: (n: number) => void;
}

interface NodeFs {
  readFileSync(path: string): Uint8Array;
}

function loadFs(): NodeFs {
  // tslint:disable-next-line:no-require-imports
  return require('fs') as NodeFs;
}

/**
 * Node-side factory for {@link HandLandmarker}. Mirrors the shape of
 * `HandLandmarker.createFromOptions` but goes through the Node module
 * loader (`fs`-backed wasm + headless-gl canvas) instead of the browser's
 * `<script>`-tag flow.
 *
 * Model assets are read off disk into Buffers up front so the underlying
 * `TaskRunner.applyOptions` never tries to `fetch()` a `modelAssetPath`.
 */
export async function createHandLandmarker(
    wasmFileset: WasmFileset,
    options: HandLandmarkerNodeOptions,
    ): Promise<HandLandmarker> {
  // Pre-resolve modelAssetPath to a Buffer so task_runner stays browser-pure.
  const baseOptions = options.baseOptions ? {...options.baseOptions} : {};
  if (baseOptions.modelAssetPath && !baseOptions.modelAssetBuffer) {
    const fs = loadFs();
    baseOptions.modelAssetBuffer = fs.readFileSync(
        baseOptions.modelAssetPath as string);
    delete (baseOptions as {modelAssetPath?: string}).modelAssetPath;
  }
  // numThreads is a Node-only knob; strip before forwarding to the upstream
  // HandLandmarker which doesn't know it.
  const {numThreads, ...upstreamOptions} = options;
  const resolvedOptions: HandLandmarkerOptions = {...upstreamOptions, baseOptions};

  const canvas = new NodeCanvas();
  const handLandmarker = await createMediaPipeLibNode(
      HandLandmarker,
      wasmFileset.wasmLoaderPath.toString(),
      wasmFileset.wasmBinaryPath.toString(),
      canvas,
  );
  // Apply numThreads BEFORE setOptions — the upstream call triggers graph
  // initialization which constructs the TFLite Interpreter, and SetNumThreads
  // is read at that point. Setting after setOptions would be a no-op.
  if (numThreads != null && numThreads > 0) {
    // tslint:disable-next-line:no-any
    const mod = (handLandmarker as any).graphRunner?.wasmModule as
        WasmModuleWithThreadOverride | undefined;
    if (mod && typeof mod._setNodeXnnpackNumThreads === 'function') {
      mod._setNodeXnnpackNumThreads(numThreads);
    }
  }
  await handLandmarker.setOptions(resolvedOptions);
  return handLandmarker;
}
