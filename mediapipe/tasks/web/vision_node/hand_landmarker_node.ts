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
    options: HandLandmarkerOptions,
    ): Promise<HandLandmarker> {
  // Pre-resolve modelAssetPath to a Buffer so task_runner stays browser-pure.
  const baseOptions = options.baseOptions ? {...options.baseOptions} : {};
  if (baseOptions.modelAssetPath && !baseOptions.modelAssetBuffer) {
    const fs = loadFs();
    baseOptions.modelAssetBuffer = fs.readFileSync(
        baseOptions.modelAssetPath as string);
    delete (baseOptions as {modelAssetPath?: string}).modelAssetPath;
  }
  const resolvedOptions: HandLandmarkerOptions = {...options, baseOptions};

  const canvas = new NodeCanvas();
  const handLandmarker = await createMediaPipeLibNode(
      HandLandmarker,
      wasmFileset.wasmLoaderPath.toString(),
      wasmFileset.wasmBinaryPath.toString(),
      canvas,
  );
  await handLandmarker.setOptions(resolvedOptions);
  return handLandmarker;
}
