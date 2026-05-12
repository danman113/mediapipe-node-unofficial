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

// Node.js drop-in replacement for `platform_utils.ts`. Aliased in by the
// `@mediapipe/tasks-vision-node` rollup config so the rest of the graph
// runner code can call the same exported names without touching browser
// globals (`navigator`, `OffscreenCanvas`, `self.document`).

export function isWebKit(_browser?: unknown) {
  return false;
}

export function isIOS() {
  return false;
}

export function supportsOffscreenCanvas(_browser?: unknown) {
  return false;
}
