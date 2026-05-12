/**
 * Worker process for parallel hand-landmarker inference.
 *
 * Launched via child_process.fork() (not worker_threads) because the `gl`
 * native addon uses the legacy NODE_MODULE API, which can't be re-registered
 * inside a worker thread.  Each forked process gets its own address space and
 * can load native addons independently.
 *
 * Protocol (IPC):
 *   Parent → child (one message): {modelPath, tasks}
 *     tasks — Array<{index: number, framePath: string}>
 *   Child → parent (one reply): {results} | {error}
 *     results — Array<{index, landmarkCount, latencyMs}>
 */

'use strict';

const {readFile} = require('node:fs/promises');
const {performance} = require('node:perf_hooks');

process.once('message', async (msg) => {
  const {modelPath, tasks} = msg;

  let detector;
  try {
    const {FilesetResolver, createHandLandmarker, decodeImageBuffer} =
        require('@danman113/mediapipe-node');

    const fileset = await FilesetResolver.forVisionTasks();
    detector = await createHandLandmarker(fileset, {
      baseOptions: {modelAssetPath: modelPath},
      numHands: 2,
      runningMode: 'IMAGE',
    });

    const results = [];
    for (const {index, framePath} of tasks) {
      const buf = await readFile(framePath);
      const imageData = await decodeImageBuffer(buf);
      const t0 = performance.now();
      const result = detector.detect(imageData);
      results.push({
        index,
        landmarkCount: result.landmarks.length,
        latencyMs: performance.now() - t0,
      });
    }

    detector.close();
    process.send({results});
  } catch (err) {
    if (detector) {
      try { detector.close(); } catch (_) {}
    }
    process.send({error: err.message || String(err)});
  }
});
