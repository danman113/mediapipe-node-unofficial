// Verifies the `numThreads` option on createHandLandmarker actually
// changes inference latency (more threads = faster on this host, fewer
// threads = slower but useful for many-fork pools).
//
// Usage: node numthreads_test.js [warmup] [runs]

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const mp = require('@danman113/mediapipe-node');

const MODEL = path.resolve('fixtures/hand_landmarker.task');
const IMAGE = path.resolve('fixtures/pointing_up.jpg');
const WARMUP = Number(process.argv[2]) || 5;
const RUNS = Number(process.argv[3]) || 50;

function stats(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    mean: sum / sorted.length,
  };
}

async function runOnce(numThreads) {
  const fileset = await mp.FilesetResolver.forVisionTasks();
  const buf = fs.readFileSync(IMAGE);
  const imageData = await mp.decodeImageBuffer(buf);
  const detector = await mp.createHandLandmarker(fileset, {
    baseOptions: {modelAssetPath: MODEL},
    numHands: 2,
    runningMode: 'IMAGE',
    numThreads,
  });
  try {
    for (let i = 0; i < WARMUP; i++) detector.detect(imageData);
    const timings = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      detector.detect(imageData);
      timings.push(performance.now() - t0);
    }
    return stats(timings);
  } finally {
    detector.close();
  }
}

async function main() {
  console.log(`${RUNS} runs, ${WARMUP} warmup, image-mode`);
  for (const n of [1, 2, 4, 8]) {
    const s = await runOnce(n);
    console.log(`numThreads=${n}  min=${s.min.toFixed(1)}ms  p50=${s.p50.toFixed(1)}ms  p95=${s.p95.toFixed(1)}ms  mean=${s.mean.toFixed(1)}ms`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
