/**
 * Phase 4: Bring Your Own Anthropic Key.
 *
 * Helpers for reading and persisting an `ANTHROPIC_API_KEY` on the host so
 * users can run SpAIglass without a Claude Max subscription.
 *
 * The key is stored in the host's .env file (the same one the installer
 * writes) and mirrored to process.env so the next Claude SDK spawn picks
 * it up without requiring a service restart.
 *
 * The relay never sees this key — it lives entirely on the host.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";

const ENV_KEY = "ANTHROPIC_API_KEY";

/**
 * Build the env-vars object to pass into the Claude Agent SDK's `env`
 * option. Returns undefined when no user-supplied key is set, so the
 * Claude CLI falls back to its default subscription auth path.
 *
 * Per-session overrides (e.g. a different key for a particular project)
 * can be threaded in by the caller via the `override` parameter.
 */
export function getClaudeSpawnEnv(
  override?: string,
): { ANTHROPIC_API_KEY: string } | undefined {
  const key = override ?? process.env[ENV_KEY];
  if (!key || !key.trim()) return undefined;
  return { ANTHROPIC_API_KEY: key.trim() };
}

/**
 * Resolve the .env file the installer wrote — used by the settings API
 * when persisting a new key. Falls back to <cwd>/.env which is what
 * spaiglass-host.ts loads at boot.
 */
function envFilePath(): string {
  return resolve(process.cwd(), ".env");
}

/**
 * Read the currently stored Anthropic API key, if any. Looks at process.env
 * first (always authoritative for the running process), then falls back to
 * parsing the .env file from disk so the settings page can show whether a
 * key is configured even before any spawn has happened.
 *
 * Returns the key itself or `null`. Callers that just want a presence flag
 * should compare to null — never echo the key back to the network.
 */
export function readStoredAnthropicKey(): string | null {
  const live = process.env[ENV_KEY];
  if (live && live.trim()) return live.trim();

  const path = envFilePath();
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*?)\s*$/);
      if (m) {
        const value = m[1].replace(/^['"]|['"]$/g, "").trim();
        return value || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Persist a new Anthropic API key to the host's .env file and mirror it
 * into process.env so the next SDK spawn picks it up immediately. Pass
 * `null` to clear the key.
 *
 * Atomically rewrites the .env: reads the existing file, replaces (or
 * appends) the ANTHROPIC_API_KEY line, writes back at mode 600.
 */
export function writeStoredAnthropicKey(key: string | null): void {
  const path = envFilePath();
  let lines: string[] = [];
  if (existsSync(path)) {
    lines = readFileSync(path, "utf-8").split(/\r?\n/);
  }

  let found = false;
  const next: string[] = [];
  for (const line of lines) {
    if (/^\s*ANTHROPIC_API_KEY\s*=/.test(line)) {
      found = true;
      if (key) next.push(`${ENV_KEY}=${key}`);
      // when key is null we drop the line entirely
      continue;
    }
    next.push(line);
  }
  if (key && !found) {
    // Trim trailing empty lines, then append
    while (next.length && next[next.length - 1] === "") next.pop();
    next.push(`${ENV_KEY}=${key}`);
    next.push("");
  }

  writeFileSync(path, next.join("\n"));
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod can fail on Windows; .env is already user-private there
  }

  // Mirror into the running process so the next Claude spawn picks it up.
  if (key) {
    process.env[ENV_KEY] = key;
  } else {
    delete process.env[ENV_KEY];
  }
}

/**
 * Validate an Anthropic API key by making a single one-token request to
 * api.anthropic.com. Used by the settings PUT endpoint before persisting.
 * Returns null on success, or a human-readable error string.
 */
export async function validateAnthropicKey(key: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (resp.ok) return null;
    if (resp.status === 401) return "Invalid API key (401 from Anthropic)";
    if (resp.status === 403) return "API key forbidden (403 from Anthropic)";
    if (resp.status === 429) {
      // Rate-limited but the key itself is valid — accept.
      return null;
    }
    const body = await resp.text().catch(() => "");
    return `Anthropic API returned ${resp.status}: ${body.slice(0, 200)}`;
  } catch (err) {
    return `Could not reach api.anthropic.com: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}
