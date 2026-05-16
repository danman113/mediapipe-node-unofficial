// Verifies createImageData (raw RGBA passthrough) matches
// decodeImageBuffer (PNG/JPEG decode via node-canvas) for the same image.
// Also measures the savings — caller-supplied raw RGBA should skip the
// node-canvas decode entirely.
//
// Usage: node raw_rgba_test.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mp = require('@danman113/mediapipe-node');

async function main() {
  const modelPath = path.resolve('fixtures/hand_landmarker.task');
  const imagePath = path.resolve('fixtures/pointing_up.jpg');

  const fileset = await mp.FilesetResolver.forVisionTasks();
  const detector = await mp.createHandLandmarker(fileset, {
    baseOptions: {modelAssetPath: modelPath},
    numHands: 2,
    runningMode: 'IMAGE',
  });

  // 1. Decode JPEG → ImageData via node-canvas (existing path).
  const buf = fs.readFileSync(imagePath);
  const decoded = await mp.decodeImageBuffer(buf);
  const decodedResult = detector.detect(decoded);

  // 2. Re-wrap the same RGBA bytes via createImageData (new path).
  const wrapped = mp.createImageData(decoded.data, decoded.width, decoded.height);
  const wrappedResult = detector.detect(wrapped);

  // 3. Compare — same input, must produce identical landmarks.
  if (decodedResult.landmarks.length !== wrappedResult.landmarks.length) {
    console.error(`FAIL: hand count differs ${decodedResult.landmarks.length} vs ${wrappedResult.landmarks.length}`);
    process.exit(1);
  }
  let maxDelta = 0;
  for (let h = 0; h < decodedResult.landmarks.length; h++) {
    const a = decodedResult.landmarks[h];
    const b = wrappedResult.landmarks[h];
    for (let i = 0; i < a.length; i++) {
      maxDelta = Math.max(maxDelta,
                          Math.abs(a[i].x - b[i].x),
                          Math.abs(a[i].y - b[i].y),
                          Math.abs(a[i].z - b[i].z));
    }
  }
  console.log(`decode-vs-rawRgba landmark max delta = ${maxDelta.toExponential(3)}`);
  if (maxDelta > 1e-6) {
    console.error('FAIL: createImageData drift > 1e-6 (should be bit-exact)');
    process.exit(1);
  }
  console.log('OK: createImageData produces bit-identical landmarks');

  // 4. Measure decode vs raw-rgba time on the JS side (this is the
  //    point — callers with pre-decoded pixels skip node-canvas entirely).
  const N = 50;
  let tDecode = 0, tRaw = 0;
  const rgbaCopy = new Uint8ClampedArray(decoded.data);  // own copy
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await mp.decodeImageBuffer(buf);
    tDecode += performance.now() - t0;
    const t1 = performance.now();
    mp.createImageData(rgbaCopy, decoded.width, decoded.height);
    tRaw += performance.now() - t1;
  }
  console.log(`decodeImageBuffer mean : ${(tDecode / N).toFixed(2)}ms (PNG/JPEG decode)`);
  console.log(`createImageData mean   : ${(tRaw / N).toFixed(3)}ms (raw RGBA wrap)`);
  console.log(`savings per frame      : ${((tDecode - tRaw) / N).toFixed(2)}ms`);
  console.log('  (this is the win for callers who already have RGBA — ffmpeg,');
  console.log('   sharp, libvips, a camera frame buffer, etc.)');

  detector.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
