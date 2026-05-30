/**
 * Tests for the resume replay slice.
 *
 * `readFramesAfter(dir, lastCursor)` is the core of session resumption: both
 * the live-resume path (manager.resumeFromCursor) and the cold-rehydrate path
 * (manager.rehydrateFromDisk) delegate to it to decide which persisted frames
 * a reconnecting browser missed. Getting the boundary wrong either drops
 * output (cursor too high) or re-streams the whole session (cursor ignored),
 * so the strictly-greater-than slice is locked down here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFramesAfter } from "./persistence.ts";

function frameLine(seq: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `f${seq}`,
    seq,
    ts: 1000 + seq,
    type: "assistant_message",
    ...extra,
  });
}

describe("readFramesAfter — resume replay slice", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "frames-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeFrames(seqs: number[]) {
    await writeFile(
      join(dir, "frames.jsonl"),
      seqs.map((s) => frameLine(s)).join("\n") + "\n",
      "utf8",
    );
  }

  it("returns all frames when lastCursor is 0 (client has nothing)", async () => {
    await writeFrames([1, 2, 3, 4, 5]);
    const out = await readFramesAfter(dir, 0);
    expect(out.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns only frames strictly newer than the cursor", async () => {
    await writeFrames([1, 2, 3, 4, 5]);
    const out = await readFramesAfter(dir, 3);
    expect(out.map((l) => JSON.parse(l).seq)).toEqual([4, 5]);
  });

  it("returns empty when the client is fully caught up", async () => {
    await writeFrames([1, 2, 3]);
    expect(await readFramesAfter(dir, 3)).toEqual([]);
  });

  it("returns empty (not throw) when no frames file exists", async () => {
    expect(await readFramesAfter(dir, 0)).toEqual([]);
  });

  it("preserves order and skips malformed/blank lines", async () => {
    await writeFile(
      join(dir, "frames.jsonl"),
      [frameLine(1), "{ not json", frameLine(2), "", frameLine(3)].join("\n"),
      "utf8",
    );
    const out = await readFramesAfter(dir, 0);
    expect(out.map((l) => JSON.parse(l).seq)).toEqual([1, 2, 3]);
  });

  it("returns the raw line verbatim, ready to forward over the WS", async () => {
    const line = frameLine(7, { complete: true });
    await writeFile(join(dir, "frames.jsonl"), line + "\n", "utf8");
    expect(await readFramesAfter(dir, 0)).toEqual([line]);
  });
});
