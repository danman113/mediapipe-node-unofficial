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

// Decodes a PNG/JPEG buffer into an `ImageData` the browser graph runner can
// ingest. Backed by the `canvas` npm package (node-canvas).

interface NodeCanvasModule {
  // tslint:disable-next-line:enforce-name-casing
  Image: new () => {
    src: Buffer | Uint8Array;
    onload: (() => void) | null;
    onerror: ((err: Error) => void) | null;
    width: number;
    height: number;
  };
  createCanvas(width: number, height: number): {
    getContext(ctx: '2d'): {
      drawImage(image: unknown, dx: number, dy: number): void;
      getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
    };
  };
}

let nodeCanvas: NodeCanvasModule | undefined;

function loadNodeCanvas(): NodeCanvasModule {
  if (nodeCanvas) return nodeCanvas;
  try {
    // tslint:disable-next-line:no-require-imports
    nodeCanvas = require('canvas') as NodeCanvasModule;
  } catch (err) {
    throw new Error(
        'Failed to load `canvas`. Install it as a peer dependency of ' +
        '@mediapipe/tasks-vision-node to decode image buffers.');
  }
  return nodeCanvas;
}

/**
 * Decodes a PNG/JPEG buffer to an `ImageData` instance. Returns a Promise so
 * callers can use the same shape as `createImageBitmap` in the browser.
 */
export function decodeImageBuffer(buffer: Buffer | Uint8Array):
    Promise<ImageData> {
  const mod = loadNodeCanvas();
  const image = new mod.Image();
  return new Promise<ImageData>((resolve, reject) => {
    image.onload = () => {
      const canvas = mod.createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      resolve(ctx.getImageData(0, 0, image.width, image.height));
    };
    image.onerror = (err: Error) => reject(err);
    // node-canvas accepts a Buffer directly via `src`.
    image.src = buffer instanceof Uint8Array ?
        buffer :
        new Uint8Array(buffer as Buffer);
  });
}
