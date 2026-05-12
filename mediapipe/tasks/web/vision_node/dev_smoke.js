#!/usr/bin/env node
/**
 * One-shot dev loop for @mediapipe/tasks-vision-node.
 *
 * Default workdir is `mediapipe/tasks/web/vision_node/smoke/` (committed
 * package.json + .gitignore; node_modules / local-pkg / fixtures all
 * untracked). One-time setup:
 *
 *   cd mediapipe/tasks/web/vision_node/smoke && npm install
 *   mkdir -p fixtures && cp /abs/hand_landmarker.task fixtures/
 *   cp /abs/hand.jpg fixtures/pointing_up.jpg
 *
 * Then on each iteration:
 *
 *   1. bazel build //mediapipe/tasks/web/vision_node:vision_node_pkg
 *   2. Refresh `<workdir>/local-pkg` from bazel-bin (handles bazel's
 *      read-only perms with chmod -R u+w + rm).
 *   3. `npm install ./local-pkg` inside the workdir.
 *   4. `node smoke_test.js <model> <image>` from the workdir.
 *
 * Skip steps with --no-build, --no-install. Pass --keep-going to ignore
 * non-zero exits between steps. Override paths with --model=, --image=,
 * --workdir=, --target=.
 *
 * From repo root:
 *   node mediapipe/tasks/web/vision_node/dev_smoke.js
 *   node mediapipe/tasks/web/vision_node/dev_smoke.js --no-build
 *   node mediapipe/tasks/web/vision_node/dev_smoke.js --image=/abs/other.jpg
 *
 * From the smoke/ directory:
 *   node ../dev_smoke.js
 */

'use strict';

const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DEFAULT_TARGET = '//mediapipe/tasks/web/vision_node:vision_node_pkg';
const DEFAULT_PKG_PATH =
    'bazel-bin/mediapipe/tasks/web/vision_node/vision_node_pkg';
const DEFAULT_WORKDIR = path.join(__dirname, 'smoke');
const DEFAULT_MODEL = 'fixtures/hand_landmarker.task';  // resolved against workdir
const DEFAULT_IMAGE = 'fixtures/pointing_up.jpg';       // resolved against workdir

function parseArgs(argv) {
  const opts = {
    build: true,
    install: true,
    keepGoing: false,
    target: DEFAULT_TARGET,
    workdir: DEFAULT_WORKDIR,
    model: DEFAULT_MODEL,
    image: DEFAULT_IMAGE,
    test: 'smoke',   // 'smoke' | 'perf'
    // Extra args forwarded verbatim to the test script (e.g. --runs=200).
    testArgs: [],
  };
  for (const arg of argv) {
    if (arg === '--no-build') opts.build = false;
    else if (arg === '--no-install') opts.install = false;
    else if (arg === '--keep-going') opts.keepGoing = true;
    else if (arg.startsWith('--target=')) opts.target = arg.slice(9);
    else if (arg.startsWith('--workdir=')) opts.workdir = arg.slice(10);
    else if (arg.startsWith('--model=')) opts.model = arg.slice(8);
    else if (arg.startsWith('--image=')) opts.image = arg.slice(8);
    else if (arg.startsWith('--test=')) opts.test = arg.slice(7);
    else if (arg === '-h' || arg === '--help') {
      console.log(
          'Usage: node dev_smoke.js [--no-build] [--no-install] ' +
          '[--keep-going] [--target=…] [--workdir=…] [--model=…] [--image=…]\n' +
          '       [--test=smoke|perf] [-- <extra args for test script>]');
      process.exit(0);
    } else if (arg === '--') {
      // Everything after '--' is forwarded to the test script.
      const sepIdx = argv.indexOf('--');
      opts.testArgs = argv.slice(sepIdx + 1);
      break;
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(64);
    }
  }
  if (!['smoke', 'perf'].includes(opts.test)) {
    console.error(`--test must be 'smoke' or 'perf', got: ${opts.test}`);
    process.exit(64);
  }
  return opts;
}

function step(label) {
  const bar = '─'.repeat(Math.max(4, 60 - label.length));
  console.log(`\n── ${label} ${bar}`);
}

function run(cmd, args, cwd, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}` + (cwd ? `  (cwd: ${cwd})` : ''));
  const result = spawnSync(cmd, args, {
    cwd: cwd ?? REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
    ...opts,
  });
  if (result.status !== 0) {
    const msg = `step failed (${cmd} exit=${result.status})`;
    if (opts.keepGoing) {
      console.warn(msg + ' — continuing because --keep-going');
      return false;
    }
    console.error(msg);
    process.exit(result.status ?? 1);
  }
  return true;
}

function refreshLocalPkg(workdir) {
  const localPkg = path.join(workdir, 'local-pkg');
  const built = path.join(REPO_ROOT, DEFAULT_PKG_PATH);
  if (!fs.existsSync(built)) {
    console.error(`built package not found at ${built}`);
    process.exit(1);
  }
  if (fs.existsSync(localPkg)) {
    // bazel sets read-only perms on the symlink farm — chmod first.
    spawnSync('chmod', ['-R', 'u+w', localPkg], {stdio: 'inherit'});
    fs.rmSync(localPkg, {recursive: true, force: true});
  }
  // -L follows symlinks so the destination is a real tree (npm install on
  // a symlink farm rooted in bazel-out walks back into bazel-out and
  // can't find peer deps).
  run('cp', ['-rL', built, localPkg]);
  spawnSync('chmod', ['-R', 'u+w', localPkg], {stdio: 'inherit'});
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.workdir)) {
    console.error(`workdir ${opts.workdir} does not exist.`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(opts.workdir, 'node_modules'))) {
    console.error(
        `peer deps not installed in ${opts.workdir}. Run once:\n` +
        `  (cd ${opts.workdir} && npm install)`);
    process.exit(1);
  }
  const fixturesDir = path.join(opts.workdir, 'fixtures');
  if (!fs.existsSync(fixturesDir)) {
    console.error(
        `${fixturesDir} not found. Drop hand_landmarker.task and a hand image ` +
        `into ${fixturesDir}/, or pass --model=/abs/path --image=/abs/path.`);
    process.exit(1);
  }

  if (opts.build) {
    step('bazel build');
    // --compilation_mode=opt: inherited by the wasm transition, giving -O2/-O3 to
    //   all transitive C++ deps (XNNPack, TFLite, MediaPipe calculators, …).
    // --features=optimized_for_speed: with opt mode, promotes -O2 → -O3 (emsdk
    //   toolchain flag_set).
    // These are forwarded through the wasm_cc_binary transition (compilation_mode
    // is inherited; features is explicitly forwarded by _wasm_transition_impl).
    run('bazel', [
      'build',
      '--compilation_mode=opt',
      '--features=optimized_for_speed',
      opts.target,
    ], REPO_ROOT, {keepGoing: opts.keepGoing});
  }

  step('refresh local-pkg');
  refreshLocalPkg(opts.workdir);

  if (opts.install) {
    step('npm install ./local-pkg');
    run('npm', ['install', './local-pkg'], opts.workdir,
        {keepGoing: opts.keepGoing});
  }

  const testScript = opts.test === 'perf' ? 'perf_test.js' : 'smoke_test.js';
  step(testScript.replace('.js', ''));
  const modelPath = path.isAbsolute(opts.model)
      ? opts.model
      : path.join(opts.workdir, opts.model);
  const imagePath = path.isAbsolute(opts.image)
      ? opts.image
      : path.join(opts.workdir, opts.image);
  // Scripts live inside the workdir (smoke/) so that require() resolves from
  // smoke/node_modules and doesn't hit vision_node/package.json self-ref.
  // smoke_test.js uses positional args; perf_test.js uses --flags.
  const testArgv = opts.test === 'perf'
      ? [`--model=${modelPath}`, `--image=${imagePath}`, ...opts.testArgs]
      : [modelPath, imagePath, ...opts.testArgs];
  run('node', [testScript, ...testArgv], opts.workdir,
      {keepGoing: opts.keepGoing});
}

main();
