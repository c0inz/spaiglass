/**
 * Tests for the files read handler's HTTP status mapping.
 *
 * The handler used to return 500 for any readFile failure, including a
 * missing file (ENOENT). Loading a role file that lives in the legacy
 * `agents/` directory instead of the native `.claude/agents/` directory
 * surfaced this as a 500 in the browser console. A missing file is a 404,
 * not a server error — this suite locks that mapping down.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { handleFileReadRequest } from "./files.ts";

/** Minimal hono Context stub that captures the json() body + status. */
function mockCtx(path?: string) {
  const captured: { body?: unknown; status?: number } = {};
  const c = {
    req: { query: (k: string) => (k === "path" ? path : undefined) },
    json: (body: unknown, status?: number) => {
      captured.body = body;
      captured.status = status ?? 200;
      return { body, status };
    },
  } as unknown as Context;
  return { c, captured };
}

describe("handleFileReadRequest status mapping", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeAll(async () => {
    // Must live under $HOME — validatePath rejects anything outside it.
    tmpDir = await mkdtemp(join(homedir(), "files-test-"));
    tmpFile = join(tmpDir, "hello.md");
    await writeFile(tmpFile, "hi there", "utf-8");
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 200 + content for an existing readable file", async () => {
    const { c, captured } = mockCtx(tmpFile);
    await handleFileReadRequest(c);
    expect(captured.status).toBe(200);
    expect((captured.body as { content: string }).content).toBe("hi there");
  });

  it("returns 404 (not 500) for a missing file", async () => {
    const { c, captured } = mockCtx(join(homedir(), "__no_such_file_xyz__.md"));
    await handleFileReadRequest(c);
    expect(captured.status).toBe(404);
  });

  it("returns 400 (not 500) when the path is a directory", async () => {
    const { c, captured } = mockCtx(tmpDir);
    await handleFileReadRequest(c);
    expect(captured.status).toBe(400);
  });

  it("returns 403 for a path outside the home directory", async () => {
    const { c, captured } = mockCtx("/etc/passwd");
    await handleFileReadRequest(c);
    expect(captured.status).toBe(403);
  });

  it("returns 400 when the path parameter is missing", async () => {
    const { c, captured } = mockCtx(undefined);
    await handleFileReadRequest(c);
    expect(captured.status).toBe(400);
  });
});
