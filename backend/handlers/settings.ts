/**
 * Phase 4: Settings API for the host's Anthropic API key.
 *
 * Two routes:
 *   GET  /api/settings/anthropic-key  — { hasKey, prefix }
 *   POST /api/settings/anthropic-key  — { key: string | null }
 *
 * The key never leaves the host. We persist into the host's .env (the
 * file the Phase-3 installer wrote) and mirror into process.env so the
 * next Claude SDK spawn picks it up without a service restart.
 *
 * Read responses NEVER include the full key — only a masked prefix so
 * the UI can show "sk-ant-...xxxx" as a confirmation hint. Writers
 * supply the raw key in the request body and we validate it against
 * api.anthropic.com before persisting.
 */

import type { Context } from "hono";
import {
  readStoredAnthropicKey,
  writeStoredAnthropicKey,
  validateAnthropicKey,
} from "../utils/anthropic-key.ts";

interface SetKeyBody {
  key: string | null;
}

function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export function handleGetAnthropicKey(c: Context) {
  const key = readStoredAnthropicKey();
  if (!key) {
    return c.json({ hasKey: false, masked: null });
  }
  return c.json({ hasKey: true, masked: maskKey(key) });
}

export async function handleSetAnthropicKey(c: Context) {
  let body: SetKeyBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Clear path
  if (body.key === null || body.key === "") {
    writeStoredAnthropicKey(null);
    return c.json({ ok: true, hasKey: false, masked: null });
  }

  if (typeof body.key !== "string") {
    return c.json({ error: "key must be a string or null" }, 400);
  }

  const trimmed = body.key.trim();
  if (!trimmed.startsWith("sk-ant-")) {
    return c.json({ error: "Anthropic API keys start with 'sk-ant-'" }, 400);
  }

  // Validate against Anthropic before persisting so we never store a
  // broken key. Network failures here surface as 502 to the caller.
  const validationError = await validateAnthropicKey(trimmed);
  if (validationError) {
    return c.json({ error: validationError }, 502);
  }

  writeStoredAnthropicKey(trimmed);
  return c.json({ ok: true, hasKey: true, masked: maskKey(trimmed) });
}
