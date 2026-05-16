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
        new Uint8Array(buffer as Uint8Array as Buffer);
  });
}

// `ImageData`-shaped object the detect/detectForVideo APIs accept. Built from
// raw RGBA bytes so callers with pixels already in memory (ffmpeg
// `-pix_fmt rgba`, sharp, a camera capture, etc.) can skip the node-canvas
// JPEG/PNG decoder.
interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'srgb';
}

// libyuv FourCC codes. `0xAABBCCDD` ASCII reversed → 'NV12' etc. (lowercase
// because libyuv defines them in C as `FOURCC('N','V','1','2')` which packs
// bytes little-endian). Kept inline so we don't pull in a libyuv types
// dep on the JS side.
const FOURCC_NV12 = 0x3231564E;
const FOURCC_NV21 = 0x3132564E;
const FOURCC_I420 = 0x30323449;

/** YUV plane layout. Determines how `decodeYuvBuffer` splits the buffer. */
export type YuvFormat = 'nv12' | 'nv21' | 'i420';

// Detector-like object that exposes the underlying wasm module — used by
// `decodeYuvBuffer` to call `_yuvToRgba` in the same module instance the
// detector was created against.
interface HasWasmModule {
  // tslint:disable:no-any enforce-name-casing
  graphRunner?: {wasmModule?: any};
}

/**
 * Converts a packed YUV buffer to an `ImageData`-shaped object via the
 * SIMD-vectorized libyuv code that ships in the WASM bundle. Caller can
 * then pass the result to `detector.detect(...)` directly.
 *
 * Why this exists: video pipelines (ffmpeg/H.264 decode, the WebRTC
 * `MediaStreamTrack` output, mobile camera frames) almost always produce
 * YUV (typically NV12 from hardware decoders or I420 from
 * `-pix_fmt yuv420p`). The previous options were both bad: re-encode to
 * RGBA on the caller side in pure JS (~10–30ms per 720p frame) or
 * roundtrip through node-canvas's JPEG decoder. libyuv inside our WASM
 * does the same conversion in roughly 0.5–1ms for 720p.
 *
 * Plane layouts:
 *   - 'nv12': Y plane (width*height bytes) + interleaved UV plane
 *             (width*height/2 bytes, U,V,U,V,…).
 *   - 'nv21': same as nv12 but the chroma plane is V,U,V,U,… (Android camera).
 *   - 'i420': Y plane + U plane (width/2 * height/2) + V plane (same size).
 *
 * `buffer.length` must be exactly `width * height * 3 / 2`.
 *
 * The first argument is the detector returned from `createHandLandmarker`.
 * We need it to access the same wasm module instance that does the
 * inference — so the conversion and the inference share heap. Pass the
 * detector you'll feed the result into.
 */
export function decodeYuvBuffer(
    detector: HasWasmModule,
    buffer: Uint8Array,
    width: number,
    height: number,
    format: YuvFormat = 'nv12'): ImageData {
  if (width <= 0 || height <= 0 || (width & 1) || (height & 1)) {
    throw new Error(
        `decodeYuvBuffer: width/height must be positive and even, got ${
            width}x${height}`);
  }
  const expected = width * height + (width * height) / 2;
  if (buffer.length !== expected) {
    throw new Error(
        `decodeYuvBuffer: buffer length ${buffer.length} != expected ${
            expected} for ${width}x${height} ${format}`);
  }
  const mod = detector.graphRunner?.wasmModule;
  if (!mod || typeof mod._yuvToRgba !== 'function') {
    throw new Error(
        'decodeYuvBuffer: detector has no _yuvToRgba export — rebuild the ' +
        'wasm bundle from @danman113/mediapipe-node>=Tier-11.');
  }

  const yLen = width * height;
  const uvLen = yLen / 2;            // for any 4:2:0 packed layout
  const rgbaLen = yLen * 4;

  const inPtr = mod._malloc(buffer.length);
  const outPtr = mod._malloc(rgbaLen);
  try {
    (mod.HEAPU8 as Uint8Array).set(buffer, inPtr);

    let fourcc: number;
    let yPtr: number, yStride: number;
    let uPtr: number, uStride: number;
    let vPtr: number, vStride: number;

    if (format === 'nv12' || format === 'nv21') {
      fourcc = format === 'nv12' ? FOURCC_NV12 : FOURCC_NV21;
      yPtr = inPtr;
      yStride = width;
      uPtr = inPtr + yLen;
      uStride = width;          // interleaved UV row stride
      vPtr = 0;
      vStride = 0;
    } else {  // i420
      fourcc = FOURCC_I420;
      yPtr = inPtr;
      yStride = width;
      uPtr = inPtr + yLen;
      uStride = width >> 1;
      vPtr = uPtr + (uvLen >> 1);
      vStride = width >> 1;
    }

    const rc = mod._yuvToRgba(yPtr, yStride, uPtr, uStride, vPtr, vStride,
                              width, height, fourcc, outPtr);
    if (rc !== 0) {
      throw new Error(
          `decodeYuvBuffer: libyuv returned ${rc} (-2 = unsupported fourcc)`);
    }

    // Copy out of the wasm heap into a stable JS-owned buffer so the caller
    // can hold the ImageData across detect() calls without our `_free`
    // racing the wasm heap allocator.
    const result = new Uint8ClampedArray(rgbaLen);
    result.set((mod.HEAPU8 as Uint8Array).subarray(outPtr, outPtr + rgbaLen));
    return createImageData(result, width, height);
  } finally {
    mod._free(inPtr);
    mod._free(outPtr);
  }
}

/**
 * Wraps a tight-packed RGBA8 buffer as an `ImageData`-shaped object that
 * `detector.detect(...)` accepts. Zero-copy: the returned object shares
 * storage with `rgba`.
 *
 * - `rgba` must be exactly `width * height * 4` bytes, row-major, 8 bits
 *   per channel, R-G-B-A order. Alpha is unused by hand_landmarker but
 *   must be present.
 * - If you only have RGB (3 channels), pad to RGBA in JS or copy via
 *   `Uint8Array.set` — there's no library helper for this yet.
 * - For YUV / NV12 / YUV420 input, convert to RGBA in your pipeline
 *   (ffmpeg `-pix_fmt rgba`, libyuv, sharp) before calling this. A
 *   direct YUV → MediaPipe path would need a new C++ bridge function
 *   wrapping `mediapipe::YUVImage`; not implemented today.
 *
 * Throws if the buffer length doesn't match `width * height * 4`.
 */
export function createImageData(
    rgba: Uint8Array | Uint8ClampedArray, width: number,
    height: number): ImageData {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(
        `createImageData: rgba length ${rgba.length} != expected ${expected} ` +
        `(${width}x${height}*4)`);
  }
  const data = rgba instanceof Uint8ClampedArray ?
      rgba :
      new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const imageData: ImageDataLike = {data, width, height, colorSpace: 'srgb'};
  return imageData as unknown as ImageData;
}
