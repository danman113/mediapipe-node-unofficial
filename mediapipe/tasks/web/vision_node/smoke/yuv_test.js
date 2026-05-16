// Validates the new decodeYuvBuffer YUV→RGBA path.
//
// Strategy:
//   1. Decode pointing_up.jpg → RGBA via node-canvas (reference).
//   2. RGBA → NV12 encode in pure JS using BT.601 limited-range.
//   3. NV12 → RGBA decode via the new `mp.decodeYuvBuffer` (libyuv in wasm).
//   4. Run hand landmarker on both. Landmarks should agree within YUV
//      quantization error (~1e-2 on normalized coords, NOT bit-exact —
//      YUV 4:2:0 chroma subsampling is information-losing).
//   5. Time the YUV decode path. Should be well under 5ms for our small
//      fixture.
//
// Usage: node yuv_test.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mp = require('@danman113/mediapipe-node');

// BT.601 limited-range RGB → YUV (JPEG/JFIF / FFmpeg `-pix_fmt yuv420p` default).
function rgbaToNv12(rgba, width, height) {
  if (width & 1 || height & 1) throw new Error('width/height must be even');
  const yPlane = new Uint8Array(width * height);
  const uvPlane = new Uint8Array(width * height / 2);
  // Y for every pixel
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      // BT.601 limited: Y = 0.257*R + 0.504*G + 0.098*B + 16
      const Y = (0.257 * r + 0.504 * g + 0.098 * b + 16) | 0;
      yPlane[y * width + x] = Y < 0 ? 0 : Y > 255 ? 255 : Y;
    }
  }
  // U,V averaged over 2x2 blocks
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let rSum = 0, gSum = 0, bSum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y + dy) * width + (x + dx)) * 4;
          rSum += rgba[i]; gSum += rgba[i + 1]; bSum += rgba[i + 2];
        }
      }
      const r = rSum / 4, g = gSum / 4, b = bSum / 4;
      const U = (-0.148 * r - 0.291 * g + 0.439 * b + 128) | 0;
      const V = (0.439 * r - 0.368 * g - 0.071 * b + 128) | 0;
      const uvIdx = (y / 2) * width + x;  // interleaved UV row
      uvPlane[uvIdx] = U < 0 ? 0 : U > 255 ? 255 : U;
      uvPlane[uvIdx + 1] = V < 0 ? 0 : V > 255 ? 255 : V;
    }
  }
  const out = new Uint8Array(yPlane.length + uvPlane.length);
  out.set(yPlane, 0);
  out.set(uvPlane, yPlane.length);
  return out;
}

function maxLandmarkDelta(a, b) {
  if (a.landmarks.length !== b.landmarks.length) {
    return {error: `hand count differs ${a.landmarks.length} vs ${b.landmarks.length}`};
  }
  let max = 0;
  for (let h = 0; h < a.landmarks.length; h++) {
    for (let i = 0; i < a.landmarks[h].length; i++) {
      const la = a.landmarks[h][i], lb = b.landmarks[h][i];
      max = Math.max(max, Math.abs(la.x - lb.x),
                          Math.abs(la.y - lb.y),
                          Math.abs(la.z - lb.z));
    }
  }
  return {max};
}

async function main() {
  const modelPath = path.resolve('fixtures/hand_landmarker.task');
  const imagePath = path.resolve('fixtures/pointing_up.jpg');

  const fileset = await mp.FilesetResolver.forVisionTasks();
  const detector = await mp.createHandLandmarker(fileset, {
    baseOptions: {modelAssetPath: modelPath},
    numHands: 2,
    runningMode: 'IMAGE',
  });

  // Reference RGBA via node-canvas.
  const buf = fs.readFileSync(imagePath);
  let rgbaRef = await mp.decodeImageBuffer(buf);
  // Crop to even dimensions if needed (NV12 4:2:0 chroma requires it).
  if (rgbaRef.width & 1 || rgbaRef.height & 1) {
    const w = rgbaRef.width & ~1, h = rgbaRef.height & ~1;
    const cropped = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      cropped.set(rgbaRef.data.subarray(y * rgbaRef.width * 4,
                                         y * rgbaRef.width * 4 + w * 4),
                  y * w * 4);
    }
    rgbaRef = mp.createImageData(cropped, w, h);
  }
  console.log(`fixture size: ${rgbaRef.width}x${rgbaRef.height}`);

  // RGBA → NV12 in JS.
  const tEnc0 = performance.now();
  const nv12 = rgbaToNv12(rgbaRef.data, rgbaRef.width, rgbaRef.height);
  console.log(`rgba→nv12 (JS reference encoder) : ${(performance.now() - tEnc0).toFixed(2)}ms`);

  // NV12 → RGBA via mp.decodeYuvBuffer (libyuv in wasm).
  const tDec0 = performance.now();
  const rgbaRoundTrip = mp.decodeYuvBuffer(detector, nv12, rgbaRef.width,
                                            rgbaRef.height, 'nv12');
  console.log(`nv12→rgba (libyuv in wasm)      : ${(performance.now() - tDec0).toFixed(3)}ms`);

  // Quick perf loop — repeated wasm-side decode.
  const N = 50;
  let t = 0;
  for (let i = 0; i < N; i++) {
    const a = performance.now();
    mp.decodeYuvBuffer(detector, nv12, rgbaRef.width, rgbaRef.height, 'nv12');
    t += performance.now() - a;
  }
  console.log(`nv12→rgba mean over ${N} runs    : ${(t / N).toFixed(3)}ms`);

  // Run hand_landmarker on both.
  const refResult = detector.detect(rgbaRef);
  const yuvResult = detector.detect(rgbaRoundTrip);

  console.log(`\nreference hands: ${refResult.landmarks.length}`);
  console.log(`yuv-rt    hands: ${yuvResult.landmarks.length}`);
  const cmp = maxLandmarkDelta(refResult, yuvResult);
  if (cmp.error) {
    console.error('FAIL: ' + cmp.error);
    detector.close();
    process.exit(1);
  }
  console.log(`landmark max delta (ref vs yuv): ${cmp.max.toExponential(3)}`);
  const TOL = 5e-3;  // YUV 4:2:0 quantization tolerance
  if (cmp.max > TOL) {
    console.error(`FAIL: delta ${cmp.max} exceeds YUV quantization tolerance ${TOL}`);
    detector.close();
    process.exit(1);
  }
  console.log(`OK: under ${TOL.toExponential(0)} (YUV chroma subsampling is lossy by design)`);

  detector.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
