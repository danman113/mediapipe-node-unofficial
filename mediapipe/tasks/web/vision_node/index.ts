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

import {FilesetResolverNode as FilesetResolverNodeImpl} from './fileset_resolver_node';
import {createHandLandmarker as createHandLandmarkerImpl} from './hand_landmarker_node';
import {decodeImageBuffer as decodeImageBufferImpl} from './image_adapter';
import {
  getProfileStats as getProfileStatsImpl,
  isProfileEnabled as isProfileEnabledImpl,
  recordPhase as recordPhaseImpl,
  resetProfileStats as resetProfileStatsImpl,
  setProfileEnabled as setProfileEnabledImpl,
  profileNow as profileNowImpl,
} from '../../../web/graph_runner/node_profile';

export {HandLandmarker} from '../../../tasks/web/vision/hand_landmarker/hand_landmarker';
export type {
  HandLandmarkerOptions,
  HandLandmarkerResult,
  Category,
  Landmark,
  NormalizedLandmark,
} from '../../../tasks/web/vision/hand_landmarker/hand_landmarker';

// tslint:disable:enforce-comments-on-exported-symbols
export const FilesetResolver = FilesetResolverNodeImpl;
export const createHandLandmarker = createHandLandmarkerImpl;
export const decodeImageBuffer = decodeImageBufferImpl;

// Profile API (no-op unless enabled via setProfileEnabled(true) or the
// MEDIAPIPE_NODE_PROFILE=1 env var). Exposes timings for the per-frame
// JS→WASM image-input shim so callers can see where the library spends time.
export const setProfileEnabled = setProfileEnabledImpl;
export const isProfileEnabled = isProfileEnabledImpl;
export const getProfileStats = getProfileStatsImpl;
export const resetProfileStats = resetProfileStatsImpl;
export const recordProfilePhase = recordPhaseImpl;
export const profileNow = profileNowImpl;
