#!/usr/bin/env node
/**
 * Tolerance-based diff for two `--save-landmarks` JSON files.
 *
 * Usage:
 *   node diff_landmarks.js <golden.json> <candidate.json> [--tol=1e-4]
 *
 * Exits 0 when the candidate matches the golden within tolerance, 1 when it
 * diverges. Reports per-coordinate max delta and the worst-offending frame +
 * landmark.
 *
 * Use this after every build-flag change to make sure correctness didn't
 * regress for a speed improvement.
 */

'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  if (argv.length < 2) {
    console.error(
        'usage: node diff_landmarks.js <golden.json> <candidate.json> ' +
        '[--tol=1e-4]');
    process.exit(64);
  }
  let tol = 1e-4;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--tol=')) tol = Number(a.slice(6));
    else {
      console.error('unknown arg: ' + a);
      process.exit(64);
    }
  }
  return {goldenPath: argv[0], candidatePath: argv[1], tol};
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function diff(golden, candidate, tol) {
  if (golden.frames.length !== candidate.frames.length) {
    return {ok: false, reason: `frame count differs: golden=${golden.frames.length}, candidate=${candidate.frames.length}`};
  }
  let maxDelta = 0;
  let worst = null;
  for (let i = 0; i < golden.frames.length; i++) {
    const gf = golden.frames[i];
    const cf = candidate.frames[i];
    if (gf.hands.length !== cf.hands.length) {
      return {ok: false, reason: `frame ${i}: hand count differs (${gf.hands.length} vs ${cf.hands.length})`};
    }
    for (let h = 0; h < gf.hands.length; h++) {
      const gh = gf.hands[h];
      const ch = cf.hands[h];
      if (gh.handedness !== ch.handedness) {
        return {ok: false, reason: `frame ${i} hand ${h}: handedness differs (${gh.handedness} vs ${ch.handedness})`};
      }
      const scoreDelta = Math.abs((gh.score ?? 0) - (ch.score ?? 0));
      if (scoreDelta > maxDelta) {
        maxDelta = scoreDelta;
        worst = {frame: i, hand: h, joint: -1, coord: 'score', delta: scoreDelta};
      }
      if (gh.landmarks.length !== ch.landmarks.length) {
        return {ok: false, reason: `frame ${i} hand ${h}: landmark count differs (${gh.landmarks.length} vs ${ch.landmarks.length})`};
      }
      for (let j = 0; j < gh.landmarks.length; j++) {
        for (const k of ['x', 'y', 'z']) {
          const d = Math.abs(gh.landmarks[j][k] - ch.landmarks[j][k]);
          if (d > maxDelta) {
            maxDelta = d;
            worst = {frame: i, hand: h, joint: j, coord: k, delta: d};
          }
        }
      }
    }
  }
  return {ok: maxDelta <= tol, maxDelta, worst};
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const golden = readJson(opts.goldenPath);
  const candidate = readJson(opts.candidatePath);
  const result = diff(golden, candidate, opts.tol);
  if (!result.ok) {
    if (result.reason) {
      console.error('FAIL: ' + result.reason);
    } else {
      const w = result.worst;
      console.error(
          `FAIL: max delta ${result.maxDelta.toExponential(3)} > tol ` +
          `${opts.tol.toExponential(0)}`);
      if (w) {
        console.error(
            `       worst at frame ${w.frame} hand ${w.hand} joint ${w.joint} ` +
            `coord ${w.coord}`);
      }
    }
    process.exit(1);
  }
  console.log(
      `OK: max delta ${result.maxDelta.toExponential(3)} <= tol ` +
      `${opts.tol.toExponential(0)}`);
}

main();
