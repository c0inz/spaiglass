/**
 * Phase 1 — ring buffer + cursor protocol unit tests.
 *
 * Tests the pure helpers in ./buffer.ts directly. SessionManager wires them
 * into broadcast() and resumeFromCursor(); covering the helpers gives us
 * confidence in the underlying replay invariants without needing to mock
 * the Claude SDK.
 */

import { describe, it, expect } from "vitest";
import {
  pushFrame,
  isCursorLost,
  framesAfter,
  DEFAULT_BUFFER_CAPS,
  type BufferState,
} from "./buffer";

function freshState(): BufferState {
  return { frames: [], bufferedBytes: 0 };
}

function makeFrame(cursor: number, payload = `frame-${cursor}`) {
  const data = JSON.stringify({ type: "test", cursor, payload });
  return { cursor, data, bytes: Buffer.byteLength(data, "utf8") };
}

describe("session buffer — pushFrame cap enforcement", () => {
  it("appends frames under the caps without dropping", () => {
    const state = freshState();
    for (let i = 1; i <= 100; i++) {
      const dropped = pushFrame(state, makeFrame(i));
      expect(dropped).toBe(0);
    }
    expect(state.frames.length).toBe(100);
    expect(state.frames[0].cursor).toBe(1);
    expect(state.frames[99].cursor).toBe(100);
  });

  it("drops oldest frames when maxFrames is exceeded", () => {
    const state = freshState();
    const caps = { maxFrames: 10, maxBytes: 1024 * 1024 };
    for (let i = 1; i <= 15; i++) {
      pushFrame(state, makeFrame(i), caps);
    }
    expect(state.frames.length).toBe(10);
    // Oldest 5 dropped → frames now hold cursors 6..15
    expect(state.frames[0].cursor).toBe(6);
    expect(state.frames[9].cursor).toBe(15);
  });

  it("drops oldest frames when maxBytes is exceeded", () => {
    const state = freshState();
    // Each frame ~50-60 bytes; cap at 200 bytes ⇒ ~3-4 frames retained
    const caps = { maxFrames: 1000, maxBytes: 200 };
    for (let i = 1; i <= 20; i++) {
      pushFrame(state, makeFrame(i, "x".repeat(20)), caps);
    }
    expect(state.bufferedBytes).toBeLessThanOrEqual(200);
    // Newest cursor must always be present
    expect(state.frames[state.frames.length - 1].cursor).toBe(20);
  });

  it("handles 100k frames without unbounded growth (Phase 1 stress test)", () => {
    const state = freshState();
    for (let i = 1; i <= 100_000; i++) {
      pushFrame(state, makeFrame(i, "padding-padding-padding"));
    }
    // Must respect both default caps strictly
    expect(state.frames.length).toBeLessThanOrEqual(
      DEFAULT_BUFFER_CAPS.maxFrames,
    );
    expect(state.bufferedBytes).toBeLessThanOrEqual(
      DEFAULT_BUFFER_CAPS.maxBytes,
    );
    // Newest frame still present, regardless of which cap fired first
    const newest = state.frames[state.frames.length - 1];
    expect(newest.cursor).toBe(100_000);
  });

  it("running byte total stays consistent with frame contents", () => {
    const state = freshState();
    const caps = { maxFrames: 50, maxBytes: 10_000 };
    for (let i = 1; i <= 200; i++) {
      pushFrame(state, makeFrame(i, "abc".repeat(i % 7)), caps);
    }
    const recomputed = state.frames.reduce((sum, f) => sum + f.bytes, 0);
    expect(state.bufferedBytes).toBe(recomputed);
  });
});

describe("session buffer — isCursorLost", () => {
  it("treats lastCursor=0 as 'replay everything' (never lost)", () => {
    const state = freshState();
    for (let i = 1; i <= 10; i++) pushFrame(state, makeFrame(i));
    expect(isCursorLost(state, 0)).toBe(false);
  });

  it("treats empty buffer as 'nothing to replay' (never lost)", () => {
    const state = freshState();
    expect(isCursorLost(state, 0)).toBe(false);
    expect(isCursorLost(state, 5)).toBe(false);
  });

  it("returns false when client cursor is in or just before the buffer range", () => {
    const state = freshState();
    for (let i = 1; i <= 10; i++) pushFrame(state, makeFrame(i));
    // Buffer holds [1..10]; client at cursor 0..10 are all fine
    expect(isCursorLost(state, 0)).toBe(false);
    expect(isCursorLost(state, 5)).toBe(false);
    expect(isCursorLost(state, 10)).toBe(false);
  });

  it("returns true when client cursor is older than the buffer's oldest", () => {
    const state = freshState();
    // Push 20 frames into a buffer that only holds 10 → drops cursors 1..10
    const caps = { maxFrames: 10, maxBytes: 1024 * 1024 };
    for (let i = 1; i <= 20; i++) pushFrame(state, makeFrame(i), caps);
    // Buffer now holds cursors 11..20. Oldest is 11.
    // Client at cursor 9 has missed cursor 10 — that's lost.
    expect(isCursorLost(state, 9)).toBe(true);
    // Client at cursor 10 is the boundary: next frame they need is 11, which
    // IS the oldest in the buffer. Not lost.
    expect(isCursorLost(state, 10)).toBe(false);
    // Client at cursor 11 is in-range.
    expect(isCursorLost(state, 11)).toBe(false);
  });
});

describe("session buffer — framesAfter replay slice", () => {
  it("returns all frames when lastCursor=0", () => {
    const state = freshState();
    for (let i = 1; i <= 5; i++) pushFrame(state, makeFrame(i));
    const replay = framesAfter(state, 0);
    expect(replay.map((f) => f.cursor)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns only frames strictly newer than lastCursor", () => {
    const state = freshState();
    for (let i = 1; i <= 10; i++) pushFrame(state, makeFrame(i));
    const replay = framesAfter(state, 7);
    expect(replay.map((f) => f.cursor)).toEqual([8, 9, 10]);
  });

  it("returns empty array when client is fully caught up", () => {
    const state = freshState();
    for (let i = 1; i <= 10; i++) pushFrame(state, makeFrame(i));
    expect(framesAfter(state, 10)).toEqual([]);
    expect(framesAfter(state, 100)).toEqual([]);
  });

  it("returns surviving frames after a cap-driven drop", () => {
    const state = freshState();
    const caps = { maxFrames: 5, maxBytes: 1024 * 1024 };
    for (let i = 1; i <= 12; i++) pushFrame(state, makeFrame(i), caps);
    // Buffer now holds cursors 8..12
    const replay = framesAfter(state, 7);
    expect(replay.map((f) => f.cursor)).toEqual([8, 9, 10, 11, 12]);
  });
});
