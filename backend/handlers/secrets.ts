/**
 * Secrets CRUD handler — stores named secrets in a local JSON file.
 *
 * Routes:
 *   GET    /api/secrets          — list all secrets (names + masked values)
 *   PUT    /api/secrets/:name    — create or update a secret
 *   DELETE /api/secrets/:name    — delete a secret
 *
 * Storage: ~/.spaiglass/secrets.json (chmod 600)
 * Values never leave the host unmasked — GET returns only name + last 5 chars.
 */

import type { Context } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { readTextFile, exists } from "../utils/fs.ts";

const SECRETS_DIR = join(homedir(), ".spaiglass");
const SECRETS_FILE = join(SECRETS_DIR, "secrets.json");

interface SecretsStore {
  [name: string]: string;
}

// Serialize all read-modify-write operations to prevent data loss
let secretsLock: Promise<void> = Promise.resolve();

async function readSecrets(): Promise<SecretsStore> {
  if (!(await exists(SECRETS_FILE))) return {};
  try {
    return JSON.parse(await readTextFile(SECRETS_FILE));
  } catch {
    return {};
  }
}

async function writeSecrets(store: SecretsStore): Promise<void> {
  await fs.mkdir(SECRETS_DIR, { recursive: true });
  // Atomic write: write to temp file then rename (prevents partial writes)
  const tmp = SECRETS_FILE + "." + randomBytes(4).toString("hex") + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmp, SECRETS_FILE);
}

function withSecretsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = secretsLock.then(fn, fn);
  secretsLock = next.then(() => {}, () => {});
  return next;
}

function mask(value: string): string {
  if (value.length <= 5) return "*".repeat(value.length);
  return "*".repeat(value.length - 5) + value.slice(-5);
}

/**
 * GET /api/secrets — returns alphabetized list with masked values.
 */
export async function handleListSecrets(c: Context) {
  const store = await readSecrets();
  const list = Object.entries(store)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({
      name,
      masked: mask(value),
      length: value.length,
    }));
  return c.json({ secrets: list });
}

/**
 * PUT /api/secrets/:name — create or update. Body: { value: string }
 */
export async function handlePutSecret(c: Context) {
  const name = c.req.param("name");
  if (!name || name.length > 128) {
    return c.json({ error: "name required (max 128 chars)" }, 400);
  }

  let body: { value?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.value !== "string" || body.value.length === 0) {
    return c.json({ error: "value must be a non-empty string" }, 400);
  }

  const value = body.value;
  return withSecretsLock(async () => {
    const store = await readSecrets();
    store[name] = value;
    await writeSecrets(store);
    return c.json({ ok: true, name, masked: mask(value) });
  });
}

/**
 * DELETE /api/secrets/:name
 */
export async function handleDeleteSecret(c: Context) {
  const name = c.req.param("name");
  if (!name) return c.json({ error: "name required" }, 400);

  return withSecretsLock(async () => {
    const store = await readSecrets();
    if (!(name in store)) {
      return c.json({ error: "secret not found" }, 404);
    }
    delete store[name];
    await writeSecrets(store);
    return c.json({ ok: true });
  });
}
