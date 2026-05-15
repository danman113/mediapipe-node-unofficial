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

// Lightweight per-frame profiling for the Node-side glue. Disabled by default
// — callers opt in via `setProfileEnabled(true)` or by setting the env var
// `MEDIAPIPE_NODE_PROFILE=1` before importing the package. Every helper here
// is a no-op when disabled, so production users pay nothing.
//
// Buckets accumulate microsecond timings keyed by phase name. The image-input
// shim records its own phases; callers can also push their own segments with
// `recordPhase`. The perf harness reads and resets between runs.

const envEnabled = (() => {
  try {
    return typeof process !== 'undefined' &&
        process.env &&
        process.env['MEDIAPIPE_NODE_PROFILE'] === '1';
  } catch (_err) {
    return false;
  }
})();

let enabled = envEnabled;

const buckets = new Map<string, number[]>();

function nowMicros(): number {
  return performance.now() * 1000;
}

/** Enable or disable profiling. Disabled by default. */
export function setProfileEnabled(value: boolean): void {
  enabled = value;
}

/** Returns whether profiling is currently enabled. */
export function isProfileEnabled(): boolean {
  return enabled;
}

/** Returns a monotonic timestamp in microseconds, or 0 when profiling is off. */
export function profileNow(): number {
  return enabled ? nowMicros() : 0;
}

/**
 * Records `(endMicros - startMicros)` to the given phase bucket. No-op when
 * profiling is disabled or either timestamp is 0.
 */
export function recordPhase(phase: string, startMicros: number,
                            endMicros?: number): void {
  if (!enabled) return;
  const end = endMicros == null ? nowMicros() : endMicros;
  if (!startMicros) return;
  let bucket = buckets.get(phase);
  if (!bucket) {
    bucket = [];
    buckets.set(phase, bucket);
  }
  bucket.push(end - startMicros);
}

export interface PhaseStats {
  phase: string;
  count: number;
  totalMicros: number;
  meanMicros: number;
  p50Micros: number;
  p95Micros: number;
  maxMicros: number;
}

/** Snapshot the buckets without resetting them. */
export function getProfileStats(): PhaseStats[] {
  const out: PhaseStats[] = [];
  for (const [phase, samples] of buckets) {
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    out.push({
      phase,
      count: n,
      totalMicros: sum,
      meanMicros: sum / n,
      p50Micros: sorted[Math.floor(n * 0.5)],
      p95Micros: sorted[Math.min(n - 1, Math.floor(n * 0.95))],
      maxMicros: sorted[n - 1],
    });
  }
  out.sort((a, b) => b.totalMicros - a.totalMicros);
  return out;
}

/** Clear all collected samples. */
export function resetProfileStats(): void {
  buckets.clear();
}
