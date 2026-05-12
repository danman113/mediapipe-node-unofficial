/**
 * Performance harness for @danman113/mediapipe-node.
 *
 * Two modes:
 *   IMAGE  — repeated detect() calls on a single frame; measures latency.
 *   VIDEO  — detectForVideo() across a sequence of frames; measures throughput.
 *
 * Usage (from smoke/):
 *
 *   # image mode (default)
 *   node perf_test.js
 *   node perf_test.js --runs=200 --warmup=20
 *
 *   # video mode via system ffmpeg
 *   node perf_test.js --video=fixtures/test_video.mp4
 *
 *   # video mode via pre-extracted PNG directory
 *   node perf_test.js --frames-dir=fixtures/frames/
 *
 *   # save annotated frames + dump JSON results
 *   node perf_test.js --video=fixtures/test_video.mp4 \
 *       --save-frames=fixtures/perf_out/ --json=perf_results.json
 */

'use strict';

const {spawnSync, fork} = require('node:child_process');
const {readFile, writeFile, mkdir, readdir, rm} = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCanvas, loadImage} = require('canvas');
const {
  FilesetResolver,
  createHandLandmarker,
  decodeImageBuffer,
} = require('@danman113/mediapipe-node');

// ─── Hand skeleton ───────────────────────────────────────────────────────────

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

async function drawLandmarks(imagePath, handsLandmarks, outPath) {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const w = img.width;
  const h = img.height;
  for (const landmarks of handsLandmarks) {
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
      ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
      ctx.stroke();
    }
    for (const [i, lm] of landmarks.entries()) {
      const isTip = [4, 8, 12, 16, 20].includes(i);
      ctx.fillStyle = isTip ? '#ff3333' : '#ffffff';
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, isTip ? 6 : 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(String(i), lm.x * w + 5, lm.y * h - 5);
    }
  }
  await writeFile(outPath, canvas.toBuffer('image/png'));
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    model: 'fixtures/hand_landmarker.task',
    image: 'fixtures/pointing_up.jpg',
    video: null,
    framesDir: null,
    warmup: 10,
    runs: 100,
    fps: 30,
    workers: 1,
    json: null,
    saveFrames: null,
    saveLandmarks: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--model=')) opts.model = arg.slice(8);
    else if (arg.startsWith('--image=')) opts.image = arg.slice(8);
    else if (arg.startsWith('--video=')) opts.video = arg.slice(8);
    else if (arg.startsWith('--frames-dir=')) opts.framesDir = arg.slice(13);
    else if (arg.startsWith('--warmup=')) opts.warmup = Number(arg.slice(9));
    else if (arg.startsWith('--runs=')) opts.runs = Number(arg.slice(7));
    else if (arg.startsWith('--fps=')) opts.fps = Number(arg.slice(6));
    else if (arg.startsWith('--workers=')) opts.workers = Number(arg.slice(10));
    else if (arg.startsWith('--json=')) opts.json = arg.slice(7);
    else if (arg.startsWith('--save-frames=')) opts.saveFrames = arg.slice(14);
    else if (arg.startsWith('--save-landmarks=')) opts.saveLandmarks = arg.slice(17);
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node perf_test.js [options]',
        '',
        '  --model=<path>          model file (default: fixtures/hand_landmarker.task)',
        '  --image=<path>          image for IMAGE mode (default: fixtures/pointing_up.jpg)',
        '  --video=<path>          video file for VIDEO mode (requires system ffmpeg)',
        '  --frames-dir=<path>     PNG frame dir for VIDEO mode (no ffmpeg needed)',
        '  --warmup=N              un-timed warmup iterations, IMAGE mode (default: 10)',
        '  --runs=N                timed iterations, IMAGE mode (default: 100)',
        '  --fps=N                 simulated fps for detectForVideo timestamps (default: 30)',
        '  --workers=N             parallel worker threads (default: 1); each loads its',
        '                          own WASM module. Uses IMAGE mode per worker. Cap at',
        `                          ${os.cpus().length} (this machine's CPU count).`,
        '  --json=<path>           write perf results as JSON',
        '  --save-frames=<dir>     write annotated output frames here (single-worker only)',
        '  --save-landmarks=<path> write per-frame landmark JSON for correctness checks',
        '                          (single-worker only; use as golden baseline to diff)',
      ].join('\n'));
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(64);
    }
  }
  const maxWorkers = os.cpus().length;
  if (opts.workers < 1 || !Number.isInteger(opts.workers)) {
    console.error('--workers must be a positive integer');
    process.exit(64);
  }
  if (opts.workers > maxWorkers) {
    console.warn(
        `--workers=${opts.workers} exceeds CPU count (${maxWorkers}); ` +
        `capping at ${maxWorkers}`);
    opts.workers = maxWorkers;
  }
  return opts;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function stats(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p) => sorted[Math.min(Math.floor(p * n), n - 1)];
  return {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
    p50: pct(0.50),
    p95: pct(0.95),
    p99: pct(0.99),
  };
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function printResults(mode, s, wallMs, heapBefore, heapAfter, extraInfo = {}) {
  const throughput = (s.n / (wallMs / 1000)).toFixed(1);
  console.log('\n' + '─'.repeat(45));
  console.log(`mode         : ${mode}`);
  console.log(`frames       : ${s.n}`);
  if (extraInfo.warmup != null) console.log(`warmup       : ${extraInfo.warmup}`);
  console.log('─'.repeat(45));
  console.log(`min          : ${s.min.toFixed(2)}ms`);
  console.log(`max          : ${s.max.toFixed(2)}ms`);
  console.log(`mean         : ${s.mean.toFixed(2)}ms`);
  console.log(`p50          : ${s.p50.toFixed(2)}ms`);
  console.log(`p95          : ${s.p95.toFixed(2)}ms`);
  console.log(`p99          : ${s.p99.toFixed(2)}ms`);
  console.log(`throughput   : ${throughput} fps`);
  console.log(`wall time    : ${(wallMs / 1000).toFixed(2)}s`);
  console.log('─'.repeat(45));
  console.log(`heap before  : ${mb(heapBefore)}`);
  console.log(`heap after   : ${mb(heapAfter)}`);
  const delta = heapAfter - heapBefore;
  console.log(`heap delta   : ${delta >= 0 ? '+' : ''}${mb(delta)}`);
  console.log('─'.repeat(45));
}

// ─── Frame extraction via ffmpeg ─────────────────────────────────────────────

function extractFrames(videoPath, fps) {
  const which = spawnSync('which', ['ffmpeg'], {encoding: 'utf8'});
  if (which.status !== 0) {
    console.error(
        'ffmpeg not found on PATH. Install it (e.g. `sudo apt install ffmpeg`)\n' +
        'or use --frames-dir=<dir> to point at pre-extracted PNGs instead.');
    process.exit(1);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-perf-'));
  console.log(`extracting frames at ${fps}fps to ${tmpDir} …`);
  const result = spawnSync(
      'ffmpeg',
      ['-i', videoPath, '-vf', `fps=${fps}`, `${tmpDir}/%05d.png`],
      {stdio: ['ignore', 'ignore', 'pipe']});
  if (result.status !== 0) {
    console.error('ffmpeg failed:\n' + result.stderr.toString());
    fs.rmSync(tmpDir, {recursive: true, force: true});
    process.exit(1);
  }
  return tmpDir;
}

function listFrames(dir) {
  return fs.readdirSync(dir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));
}

// ─── Landmark persistence ─────────────────────────────────────────────────────

/**
 * Serialize per-frame landmark results to a JSON golden file.
 *
 * Schema:
 *   {
 *     "model": "<basename of model file>",
 *     "mode":  "VIDEO" | "IMAGE",
 *     "fps":   <number, video mode only>,
 *     "frames": [
 *       {
 *         "index": <int>,
 *         "path":  "<basename of source image>",
 *         "hands": [
 *           {
 *             "handedness": "Left" | "Right",
 *             "score":      <float>,
 *             "landmarks":  [{"x":<f>,"y":<f>,"z":<f>}, ...]   // 21 joints
 *           }
 *         ]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Coordinates are normalized [0,1] (x,y) / depth-relative (z), matching
 * the MediaPipe NormalizedLandmark convention.  Round-trip diff with a
 * tolerance of 1e-4 catches any regression without false positives from
 * floating-point jitter.
 */
async function saveLandmarks(outPath, framePaths, detections, opts) {
  const frames = detections.map((result, i) => ({
    index: i,
    path: path.basename(framePaths[i]),
    hands: result.landmarks.map((landmarks, hi) => {
      const h = result.handednesses && result.handednesses[hi];
      return {
        handedness: h && h[0] ? h[0].categoryName : null,
        score: h && h[0] ? Number(h[0].score.toFixed(4)) : null,
        landmarks: landmarks.map((lm) => ({
          x: Number(lm.x.toFixed(6)),
          y: Number(lm.y.toFixed(6)),
          z: Number(lm.z.toFixed(6)),
        })),
      };
    }),
  }));
  const doc = {
    model: path.basename(opts.model),
    mode: (opts.video || opts.framesDir) ? 'VIDEO' : 'IMAGE',
    fps: opts.fps,
    frames,
  };
  await writeFile(outPath, JSON.stringify(doc, null, 2) + '\n');
  const handFrames = frames.filter((f) => f.hands.length > 0).length;
  console.log(
      `landmarks saved → ${outPath}  ` +
      `(${frames.length} frames, ${handFrames} with detections)`);
}

// ─── Benchmarks ──────────────────────────────────────────────────────────────

async function runImageBench(detector, imagePath, imageData, opts, saveLandmarksPath) {
  console.log(`\nWarmup (${opts.warmup} frames) …`);
  for (let i = 0; i < opts.warmup; i++) detector.detect(imageData);

  console.log(`Measuring (${opts.runs} frames) …`);
  const heapBefore = process.memoryUsage().heapUsed;
  const timings = [];
  const detections = [];
  const wallStart = performance.now();
  for (let i = 0; i < opts.runs; i++) {
    const t0 = performance.now();
    const result = detector.detect(imageData);
    timings.push(performance.now() - t0);
    detections.push(result);
  }
  const wallMs = performance.now() - wallStart;
  const heapAfter = process.memoryUsage().heapUsed;

  if (saveLandmarksPath) {
    // Save only the first run's result (all identical for a static image).
    await saveLandmarks(
        saveLandmarksPath,
        [imagePath],
        [detections[0]],
        opts);
  }

  const s = stats(timings);
  printResults('IMAGE', s, wallMs, heapBefore, heapAfter, {warmup: opts.warmup});
  return {mode: 'IMAGE', stats: s, wallMs, heapBefore, heapAfter, warmup: opts.warmup};
}

async function runVideoBench(detector, framePaths, opts, saveFramesDir, saveLandmarksPath) {
  // Phase 1 — decode all frames up front so I/O is excluded from timings.
  console.log(`\nDecoding ${framePaths.length} frames …`);
  const frames = [];
  for (const [i, framePath] of framePaths.entries()) {
    const buf = await readFile(framePath);
    frames.push({framePath, imageData: await decodeImageBuffer(buf)});
    if ((i + 1) % 30 === 0 || i + 1 === framePaths.length) {
      process.stdout.write(`  decoded ${i + 1}/${framePaths.length}\r`);
    }
  }
  process.stdout.write('\n');

  // Phase 2 — timed inference loop (no I/O, no drawing).
  console.log('Running inference …');
  const heapBefore = process.memoryUsage().heapUsed;
  const timings = [];
  const detections = [];   // collect results for post-processing
  const wallStart = performance.now();

  for (const [i, {imageData}] of frames.entries()) {
    const ts = i * (1000 / opts.fps);
    const t0 = performance.now();
    const result = detector.detectForVideo(imageData, ts);
    timings.push(performance.now() - t0);
    detections.push(result);

    if ((i + 1) % 30 === 0 || i + 1 === framePaths.length) {
      process.stdout.write(`  frame ${i + 1}/${framePaths.length}\r`);
    }
  }
  process.stdout.write('\n');

  const wallMs = performance.now() - wallStart;
  const heapAfter = process.memoryUsage().heapUsed;

  // Phase 3 — post-processing (excluded from timings).
  if (saveFramesDir) {
    console.log('Saving debug frames …');
    for (const [i, result] of detections.entries()) {
      if (result.landmarks.length > 0) {
        const outFile = path.join(saveFramesDir, path.basename(frames[i].framePath));
        await drawLandmarks(frames[i].framePath, result.landmarks, outFile);
      }
    }
  }

  if (saveLandmarksPath) {
    await saveLandmarks(saveLandmarksPath, frames.map((f) => f.framePath), detections, opts);
  }

  const s = stats(timings);
  printResults('VIDEO', s, wallMs, heapBefore, heapAfter);
  return {mode: 'VIDEO', stats: s, wallMs, heapBefore, heapAfter, frameCount: framePaths.length};
}

// ─── Worker pool bench ───────────────────────────────────────────────────────

/**
 * Run detect() across N parallel worker threads, each with its own WASM module.
 *
 * IMAGE mode  (framePaths.length === 0):
 *   Each worker runs opts.runs invocations of the same image.
 *   Total frames = N * opts.runs; throughput measures parallelism.
 *
 * VIDEO mode  (framePaths.length > 0):
 *   Frames are split into N sequential chunks (one per worker).
 *   Each worker runs detect() (IMAGE mode) — no timestamp ordering needed.
 *   Throughput = total frames / wall time of slowest worker.
 *
 * Each worker loads its own WASM module (~150–300 MB RSS each).
 */
async function runWorkerBench(modelPath, imagePath, framePaths, opts) {
  const workerScript = path.join(__dirname, 'detector_worker.js');
  const n = opts.workers;
  const videoMode = framePaths.length > 0;

  // Build a flat task list: [{index, framePath}]
  let allTasks;
  if (videoMode) {
    allTasks = framePaths.map((p, i) => ({index: i, framePath: p}));
  } else {
    // Each worker gets opts.runs tasks, all pointing at the same image.
    allTasks = [];
    for (let i = 0; i < n * opts.runs; i++) {
      allTasks.push({index: i, framePath: imagePath});
    }
  }

  // Split into N chunks (sequential blocks, not round-robin, to keep each
  // worker's I/O pattern cache-friendly).
  const chunks = Array.from({length: n}, () => []);
  for (let i = 0; i < allTasks.length; i++) {
    chunks[i % n].push(allTasks[i]);
  }

  const mode = videoMode ? 'VIDEO' : 'IMAGE';
  console.log(
      `\nSpawning ${n} workers (${mode} mode, ` +
      `${allTasks.length} total frames) …`);
  console.log('Note: each worker emits MediaPipe startup logs to stderr.\n');

  const heapBefore = process.memoryUsage().heapUsed;
  const wallStart = performance.now();

  // Launch all workers in parallel using child_process.fork (not worker_threads)
  // because the `gl` native addon uses the legacy NODE_MODULE API which can't
  // be re-registered inside a worker thread.
  const workerResults = await Promise.all(chunks.map((tasks, wi) => {
    return new Promise((resolve, reject) => {
      const child = fork(workerScript, [], {
        cwd: __dirname,
        // Children inherit stdio; their MediaPipe startup logs go to the
        // parent's stderr (noisy but visible for debugging).
      });
      child.once('message', (msg) => {
        if (msg.error) {
          reject(new Error(`worker ${wi}: ${msg.error}`));
        } else {
          resolve(msg.results);
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`worker ${wi} exited with code ${code}`));
        }
      });
      child.send({modelPath, tasks});
    });
  }));

  const wallMs = performance.now() - wallStart;
  const heapAfter = process.memoryUsage().heapUsed;

  // Flatten and sort by original index.
  const flat = workerResults.flat().sort((a, b) => a.index - b.index);
  const timings = flat.map((r) => r.latencyMs);

  const s = stats(timings);
  printResults(
      `${mode} (${n} workers)`, s, wallMs, heapBefore, heapAfter,
      videoMode ? {} : {warmup: 0});
  return {
    mode,
    workers: n,
    stats: s,
    wallMs,
    heapBefore,
    heapAfter,
    totalFrames: allTasks.length,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const modelPath = path.resolve(opts.model);
  if (!fs.existsSync(modelPath)) {
    console.error(`model not found: ${modelPath}`);
    process.exit(1);
  }

  const videoMode = opts.video != null || opts.framesDir != null;

  // Determine frame list for video mode early so we can error-check before
  // spending time loading the model.
  let framePaths = [];
  let tmpDir = null;
  if (videoMode) {
    if (opts.video) {
      tmpDir = extractFrames(path.resolve(opts.video), opts.fps);
      framePaths = listFrames(tmpDir);
    } else {
      framePaths = listFrames(path.resolve(opts.framesDir));
    }
    if (framePaths.length === 0) {
      console.error('No frames found.');
      if (tmpDir) fs.rmSync(tmpDir, {recursive: true, force: true});
      process.exit(1);
    }
    console.log(`found ${framePaths.length} frames`);
  }

  if (opts.saveFrames) {
    await mkdir(path.resolve(opts.saveFrames), {recursive: true});
  }

  const imagePath = path.resolve(opts.image);

  let results;
  if (opts.workers > 1) {
    // Worker pool path — no single detector needed in main thread.
    if (!fs.existsSync(imagePath) && !videoMode) {
      console.error(`image not found: ${imagePath}`);
      process.exit(1);
    }
    if (opts.saveLandmarks) {
      console.warn('--save-landmarks is not supported with --workers > 1; use single-worker mode for golden files.');
    }
    if (opts.saveFrames) {
      console.warn('--save-frames is not supported with --workers > 1; use single-worker mode for debug frames.');
    }
    try {
      results = await runWorkerBench(modelPath, imagePath, framePaths, opts);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  } else {
    // Single-threaded path (original behaviour).
    console.log('Loading model …');
    const fileset = await FilesetResolver.forVisionTasks();
    const detector = await createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: modelPath},
      numHands: 2,
      runningMode: videoMode ? 'VIDEO' : 'IMAGE',
    });

    const saveLandmarksPath = opts.saveLandmarks ? path.resolve(opts.saveLandmarks) : null;

    try {
      if (videoMode) {
        results = await runVideoBench(
            detector, framePaths, opts,
            opts.saveFrames ? path.resolve(opts.saveFrames) : null,
            saveLandmarksPath);
      } else {
        if (!fs.existsSync(imagePath)) {
          console.error(`image not found: ${imagePath}`);
          process.exit(1);
        }
        const buf = await readFile(imagePath);
        const imageData = await decodeImageBuffer(buf);
        results = await runImageBench(detector, imagePath, imageData, opts, saveLandmarksPath);
      }
    } finally {
      detector.close();
      if (tmpDir) fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  }

  if (opts.saveFrames) {
    console.log(`annotated frames saved to ${path.resolve(opts.saveFrames)}`);
  }

  if (opts.json) {
    const jsonPath = path.resolve(opts.json);
    await writeFile(jsonPath, JSON.stringify(results, null, 2));
    console.log(`results written to ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
