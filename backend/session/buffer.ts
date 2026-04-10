/**
 * Ring buffer for session replay (Phase 1 — session resumption after disconnect).
 *
 * Pure functions over a `BufferedFrame[]` so the buffer logic can be unit-tested
 * without mocking the Claude SDK or constructing a SessionManager. The
 * SessionManager owns the array and the running byte total; these helpers
 * just enforce the cap and answer cursor lookups.
 *
 * Cursor semantics:
 * - Cursors are 1-based, monotonic, never reused.
 * - `lastCursor === 0` means "I have nothing — replay everything you have".
 * - A `lastCursor` older than the buffer's oldest cursor (i.e. has aged out)
 *   means the client missed unrecoverable history → caller sends `resume_lost`.
 */

export interface BufferedFrame {
  cursor: number;
  data: string;
  bytes: number;
}

export interface BufferCaps {
  maxFrames: number;
  maxBytes: number;
}

export interface BufferState {
  frames: BufferedFrame[];
  /** Running total of `bytes` across all frames in the buffer. */
  bufferedBytes: number;
}

/**
 * Default caps from ROADMAP Phase 1: 4 MiB or 20K frames, whichever hits first.
 */
export const DEFAULT_BUFFER_CAPS: BufferCaps = {
  maxFrames: 20_000,
  maxBytes: 4 * 1024 * 1024,
};

/**
 * Append a frame and enforce caps. Drops oldest frames until both limits are
 * satisfied. Mutates `state` in place. Returns the number of frames dropped.
 */
export function pushFrame(
  state: BufferState,
  frame: BufferedFrame,
  caps: BufferCaps = DEFAULT_BUFFER_CAPS,
): number {
  state.frames.push(frame);
  state.bufferedBytes += frame.bytes;

  let dropped = 0;
  while (
    state.frames.length > caps.maxFrames ||
    state.bufferedBytes > caps.maxBytes
  ) {
    const old = state.frames.shift();
    if (!old) break;
    state.bufferedBytes -= old.bytes;
    dropped++;
  }
  return dropped;
}

/**
 * Returns true if `lastCursor` refers to a frame that has been dropped from
 * the buffer (i.e. the client has missed unrecoverable history).
 *
 * Edge cases:
 * - `lastCursor === 0` is never lost — it means "give me everything".
 * - An empty buffer with `lastCursor > 0` is NOT lost as long as nothing has
 *   been pushed yet (`nextCursor` is the only authoritative source for that
 *   distinction; the caller should pass it via `nextCursor` if needed).
 *   Here we treat empty buffer as "nothing to replay, no loss".
 */
export function isCursorLost(state: BufferState, lastCursor: number): boolean {
  if (lastCursor === 0) return false;
  const oldest = state.frames[0];
  if (!oldest) return false;
  // The client has cursor N. They're caught up if N === oldest.cursor - 1.
  // They've missed frames if N < oldest.cursor - 1.
  return lastCursor < oldest.cursor - 1;
}

/**
 * Returns all frames whose cursor is strictly greater than `lastCursor`.
 * Caller is responsible for first checking `isCursorLost`.
 */
export function framesAfter(
  state: BufferState,
  lastCursor: number,
): BufferedFrame[] {
  if (lastCursor === 0) return state.frames.slice();
  return state.frames.filter((f) => f.cursor > lastCursor);
}
