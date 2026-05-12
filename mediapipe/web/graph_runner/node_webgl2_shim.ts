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

// Patches a WebGL1 context (e.g. headless-gl) with stubs for the WebGL2
// entry points MediaPipe's Emscripten WebGL glue calls. Each stub is the
// minimum needed to make the C++ → Emscripten → JS → headless-gl path
// not throw; correctness is preserved by issuing `glFinish()` for sync
// barriers (forcing pipeline drain). Track A of NODE_TARGET_PLAN_STAGE2.

// WebGL2 sync constants (subset Emscripten calls into).
const SYNC_GPU_COMMANDS_COMPLETE = 0x9117;
const SYNC_FLUSH_COMMANDS_BIT = 0x00000001;
const SYNC_STATUS = 0x9114;
const UNSIGNALED = 0x9118;
const SIGNALED = 0x9119;
const ALREADY_SIGNALED = 0x911A;
const TIMEOUT_EXPIRED = 0x911B;
const CONDITION_SATISFIED = 0x911C;
const WAIT_FAILED = 0x911D;
const OBJECT_TYPE = 0x9112;
const SYNC_CONDITION = 0x9113;
const SYNC_FLAGS = 0x9116;
const SYNC_FENCE = 0x9116;

interface FakeSync {
  __mpFakeSync: true;
  signaled: boolean;
}

// tslint:disable:no-any
type GLAny = WebGLRenderingContext & Record<string, any>;

function installSyncStubs(gl: GLAny): void {
  if (typeof gl.fenceSync === 'function') return;  // already WebGL2

  // Constants — Emscripten reads these off the gl object as well as the
  // gl.SOMETHING access in the wrapped library. Define what we touch.
  if (gl.SYNC_GPU_COMMANDS_COMPLETE === undefined) {
    gl.SYNC_GPU_COMMANDS_COMPLETE = SYNC_GPU_COMMANDS_COMPLETE;
  }
  if (gl.SYNC_FLUSH_COMMANDS_BIT === undefined) {
    gl.SYNC_FLUSH_COMMANDS_BIT = SYNC_FLUSH_COMMANDS_BIT;
  }
  if (gl.SYNC_STATUS === undefined) gl.SYNC_STATUS = SYNC_STATUS;
  if (gl.UNSIGNALED === undefined) gl.UNSIGNALED = UNSIGNALED;
  if (gl.SIGNALED === undefined) gl.SIGNALED = SIGNALED;
  if (gl.ALREADY_SIGNALED === undefined) gl.ALREADY_SIGNALED = ALREADY_SIGNALED;
  if (gl.TIMEOUT_EXPIRED === undefined) gl.TIMEOUT_EXPIRED = TIMEOUT_EXPIRED;
  if (gl.CONDITION_SATISFIED === undefined) {
    gl.CONDITION_SATISFIED = CONDITION_SATISFIED;
  }
  if (gl.WAIT_FAILED === undefined) gl.WAIT_FAILED = WAIT_FAILED;
  if (gl.OBJECT_TYPE === undefined) gl.OBJECT_TYPE = OBJECT_TYPE;
  if (gl.SYNC_CONDITION === undefined) gl.SYNC_CONDITION = SYNC_CONDITION;
  if (gl.SYNC_FLAGS === undefined) gl.SYNC_FLAGS = SYNC_FLAGS;
  if (gl.SYNC_FENCE === undefined) gl.SYNC_FENCE = SYNC_FENCE;

  // fenceSync: return a pre-signaled sentinel without calling gl.finish().
  // On WSL2/Mesa the finish() call hits a display-subsystem sync that
  // takes ~1 second per frame. Since we use the basic CPU converter,
  // nothing is actually on the GPU pipeline, so the drain is a no-op.
  gl.fenceSync = (_condition: number, _flags: number): FakeSync => {
    return {__mpFakeSync: true, signaled: true};
  };

  // The fence has already drained; report ALREADY_SIGNALED so callers
  // proceed without further waiting.
  gl.clientWaitSync =
      (sync: FakeSync, _flags: number, _timeout: number): number => {
        if (!sync || !sync.__mpFakeSync) return WAIT_FAILED;
        return ALREADY_SIGNALED;
      };

  // Server-side wait — also a no-op since work is already done.
  gl.waitSync =
      (_sync: FakeSync, _flags: number, _timeout: number): void => {};

  gl.deleteSync = (_sync: FakeSync): void => {
    // No backing resource to free; the sentinel becomes garbage when
    // the C++ side drops its handle.
  };

  gl.isSync = (sync: FakeSync | null): boolean => {
    return !!(sync && sync.__mpFakeSync);
  };

  gl.getSyncParameter = (sync: FakeSync, pname: number): number => {
    if (!sync || !sync.__mpFakeSync) return 0;
    switch (pname) {
      case SYNC_STATUS:
        return SIGNALED;
      case OBJECT_TYPE:
        return SYNC_FENCE;
      case SYNC_CONDITION:
        return SYNC_GPU_COMMANDS_COMPLETE;
      case SYNC_FLAGS:
        return 0;
      default:
        return 0;
    }
  };
}

// Vertex Array Objects → OES_vertex_array_object.
function installVaoStubs(gl: GLAny): void {
  if (typeof gl.createVertexArray === 'function') return;
  const ext = gl.getExtension('OES_vertex_array_object');
  if (!ext) {
    // Hard-fail at *call* time, not install time, so simple programs
    // that never touch VAOs still work.
    const fail = () => {
      throw new Error('Vertex array objects unavailable in this context');
    };
    gl.createVertexArray = fail;
    gl.bindVertexArray = fail;
    gl.deleteVertexArray = fail;
    gl.isVertexArray = () => false;
    return;
  }
  gl.createVertexArray = () => ext.createVertexArrayOES();
  gl.bindVertexArray = (vao: WebGLVertexArrayObjectOES | null) =>
      ext.bindVertexArrayOES(vao);
  gl.deleteVertexArray = (vao: WebGLVertexArrayObjectOES | null) =>
      ext.deleteVertexArrayOES(vao);
  gl.isVertexArray = (vao: WebGLVertexArrayObjectOES | null) =>
      ext.isVertexArrayOES(vao);
}

// Multiple render targets → WEBGL_draw_buffers.
function installDrawBuffersStub(gl: GLAny): void {
  if (typeof gl.drawBuffers === 'function') return;
  const ext = gl.getExtension('WEBGL_draw_buffers');
  if (!ext) {
    gl.drawBuffers = () => {
      throw new Error('drawBuffers unavailable in this context');
    };
    return;
  }
  gl.drawBuffers = (buffers: number[]) => ext.drawBuffersWEBGL(buffers);
}

// Instanced rendering → ANGLE_instanced_arrays.
function installInstancedStubs(gl: GLAny): void {
  if (typeof gl.drawArraysInstanced === 'function') return;
  const ext = gl.getExtension('ANGLE_instanced_arrays');
  if (!ext) return;
  gl.drawArraysInstanced =
      (mode: number, first: number, count: number, primcount: number) =>
          ext.drawArraysInstancedANGLE(mode, first, count, primcount);
  gl.drawElementsInstanced =
      (mode: number, count: number, type: number, offset: number,
       primcount: number) =>
          ext.drawElementsInstancedANGLE(mode, count, type, offset, primcount);
  gl.vertexAttribDivisor = (index: number, divisor: number) =>
      ext.vertexAttribDivisorANGLE(index, divisor);
}

/**
 * Mutates the given WebGL1 context in-place, adding the WebGL2 entry
 * points MediaPipe's Emscripten glue requires. Idempotent; safe to call
 * on a context that already has any of the methods.
 */
export function installWebGL2Shim(gl: WebGLRenderingContext): void {
  const g = gl as GLAny;
  installSyncStubs(g);
  installVaoStubs(g);
  installDrawBuffersStub(g);
  installInstancedStubs(g);
}
