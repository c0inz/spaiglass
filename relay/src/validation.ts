/**
 * Request-input validation for connector/fleet API routes.
 *
 * Two goals:
 *   1. Enforce ONE canonical name/slug rule everywhere (create, rename, lookup).
 *      A name that passes POST must also be rename-able — any divergence means
 *      a connector can be created that can never be cleanly renamed, which is
 *      how yesterday's fleet-breakage bug started.
 *   2. Refuse bogus input loudly. API callers are agents written by third
 *      parties; we assume adversarial-ish shape (missing fields, wrong types,
 *      injected control characters, reserved slugs that would collide with
 *      relay routes).
 */

// Slugs appear in /vm/<login>.<slug>/... URLs, so they must be URL-safe and
// not collide with top-level relay routes.
const SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Reserved: any slug that would shadow an existing relay route prefix.
// Case-insensitive match. Kept explicit; don't rely on "the route doesn't
// exist yet" because routes are added over time.
const RESERVED_SLUGS = new Set([
  "api",
  "vm",
  "setup",
  "auth",
  "install",
  "install.sh",
  "install.ps1",
  "releases",
  "release",
  "dist.tar.gz",
  "add-project",
  "roletemplate",
  "roletemplate.md",
  "architecture-manual",
  "terms",
  "privacy",
  "fleetrelay",
  "health",
  "dashboard",
]);

// UUIDs are what connector ids look like. Reject non-UUID :id params before
// they reach the DB — otherwise every garbage string hits SQLite as a
// parameterized query that returns no rows, which looks identical to "not
// found" and makes debugging harder.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; error: string; status: 400 | 404 };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

/**
 * Validate a connector slug/name. Single source of truth — used by both
 * POST (create) and PATCH (rename). Trims, then enforces:
 *   - string type
 *   - non-empty, length 1..100
 *   - charset: ^[A-Za-z0-9][A-Za-z0-9._-]*$
 *   - not a reserved route prefix
 *   - no control characters (belt-and-suspenders — the regex already excludes them)
 */
export function validateConnectorName(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, error: "name must be a string", status: 400 };
  }
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, error: "name must not be empty", status: 400 };
  }
  if (name.length > 100) {
    return { ok: false, error: "name max 100 chars", status: 400 };
  }
  if (!SLUG_REGEX.test(name)) {
    return {
      ok: false,
      error:
        "name must start alphanumeric and contain only letters, digits, dot, hyphen, underscore",
      status: 400,
    };
  }
  // Disallow control chars / high unicode just in case (regex covers ASCII
  // only, but explicit check here documents intent).
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, error: "name contains control characters", status: 400 };
    }
  }
  if (RESERVED_SLUGS.has(name.toLowerCase())) {
    return {
      ok: false,
      error: `name '${name}' is reserved — pick a different slug`,
      status: 400,
    };
  }
  return { ok: true, value: name };
}

/** Validate a free-form human display label (nullable). Max 100 chars after trim. */
export function validateDisplayName(
  raw: unknown,
): ValidationResult<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "displayName must be a string or null", status: 400 };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > 100) {
    return { ok: false, error: "displayName max 100 chars", status: 400 };
  }
  // Allow richer chars in display names (unicode letters, spaces), but reject
  // control chars and stray line breaks.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return {
        ok: false,
        error: "displayName contains control characters",
        status: 400,
      };
    }
  }
  return { ok: true, value: trimmed };
}

/** Reject non-UUID :id params before they touch the DB. */
export function validateUuidParam(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || !UUID_REGEX.test(raw)) {
    return { ok: false, error: "invalid connector id", status: 404 };
  }
  return { ok: true, value: raw.toLowerCase() };
}

/**
 * Parse JSON body with strict shape checking. Returns {} on empty/invalid
 * body so routes can uniformly read `body.foo` without crashing, but
 * signals the caller separately if it was malformed so they can reject.
 */
export async function parseJsonBody(
  req: { json: () => Promise<unknown>; header: (name: string) => string | undefined },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const ct = (req.header("content-type") || "").toLowerCase();
  if (ct && !ct.includes("application/json")) {
    return { ok: false, error: "Content-Type must be application/json" };
  }
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Reject request bodies that include keys the endpoint doesn't recognize.
 * Catches typos (`displayname` vs `displayName`) and silently-ignored fields
 * that might look like they worked but didn't.
 */
export function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): ValidationErr | null {
  const extras = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extras.length > 0) {
    return {
      ok: false,
      error: `Unknown fields: ${extras.join(", ")}. Allowed: ${allowed.join(", ")}`,
      status: 400,
    };
  }
  return null;
}
