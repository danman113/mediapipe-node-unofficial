/**
 * Smoke test for @danman113/mediapipe-node.
 *
 * Run via dev_smoke.js (from repo root):
 *   node mediapipe/tasks/web/vision_node/dev_smoke.js
 *
 * Or directly after one-time setup in this directory:
 *   node smoke_test.js fixtures/hand_landmarker.task fixtures/pointing_up.jpg
 *
 * Validates:
 *   - The Node bundle loads (no `document` / `navigator` ReferenceError).
 *   - headless-gl satisfies the Emscripten WebGL contract enough to
 *     instantiate the wasm module.
 *   - HandLandmarker.detect() returns 21 landmarks per detected hand,
 *     each with x/y in [0,1].
 *
 * If this script fails partway through wasm instantiation with a missing
 * WebGL2 entry point, that's the Stage 1 → Stage 2 escalation signal.
 */

'use strict';

const {readFile, writeFile} = require('node:fs/promises');
const path = require('node:path');
const {createCanvas, loadImage} = require('canvas');

const {
  FilesetResolver,
  createHandLandmarker,
  decodeImageBuffer,
} = require('@danman113/mediapipe-node');

const EXPECTED_LANDMARKS_PER_HAND = 21;

// MediaPipe hand skeleton connections (pairs of landmark indices).
const HAND_CONNECTIONS = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm
  [5, 9], [9, 13], [13, 17],
];

async function saveDebugImage(imagePath, handsLandmarks) {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const w = img.width;
  const h = img.height;

  for (const landmarks of handsLandmarks) {
    // Skeleton lines
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
      ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
      ctx.stroke();
    }

    // Landmark dots
    for (const [i, lm] of landmarks.entries()) {
      const x = lm.x * w;
      const y = lm.y * h;
      // Fingertips (4, 8, 12, 16, 20) larger and red; rest white.
      const isTip = [4, 8, 12, 16, 20].includes(i);
      ctx.fillStyle = isTip ? '#ff3333' : '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, isTip ? 6 : 4, 0, 2 * Math.PI);
      ctx.fill();
      // Index number
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(String(i), x + 5, y - 5);
    }
  }

  const outPath = path.join(path.dirname(imagePath), 'debug_output.png');
  await writeFile(outPath, canvas.toBuffer('image/png'));
  console.log('debug image saved to', outPath);
}

async function main() {
  const [, , modelPath, imagePath] = process.argv;
  if (!modelPath || !imagePath) {
    console.error(
        'Usage: node smoke_test.js <hand_landmarker.task> <image.png>');
    process.exit(64);
  }

  const fileset = await FilesetResolver.forVisionTasks();
  const detector = await createHandLandmarker(fileset, {
    baseOptions: {modelAssetPath: path.resolve(modelPath)},
    numHands: 2,
    runningMode: 'IMAGE',
  });

  const buffer = await readFile(path.resolve(imagePath));
  const imageData = await decodeImageBuffer(buffer);

  const result = detector.detect(imageData);
  console.log('hands detected:', result.landmarks.length);

  if (result.landmarks.length === 0) {
    console.warn(
        'No hands detected. The smoke test passed wasm/gl instantiation, ' +
        'but the model returned no detections — try a clearer hand image.');
    detector.close();
    return;
  }

  for (const [i, hand] of result.landmarks.entries()) {
    if (hand.length !== EXPECTED_LANDMARKS_PER_HAND) {
      throw new Error(
          `hand ${i}: expected ${EXPECTED_LANDMARKS_PER_HAND} landmarks, ` +
          `got ${hand.length}`);
    }
    for (const [j, lm] of hand.entries()) {
      if (lm.x < 0 || lm.x > 1 || lm.y < 0 || lm.y > 1) {
        throw new Error(
            `hand ${i} landmark ${j}: x/y outside [0,1] (${lm.x}, ${lm.y})`);
      }
    }
  }

  console.log('OK — landmark structure matches expectations.');
  await saveDebugImage(path.resolve(imagePath), result.landmarks);
  detector.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
