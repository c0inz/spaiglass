# Secrets Roadmap

**Status:** Parked. SecretsPanel is hidden in the UI (Keys tab removed from
`FileSidebar.tsx`). The backend `/api/secrets` routes and
`~/.spaiglass/secrets.json` vault still exist but are unreachable from the
frontend. Nothing writes new secrets; existing ones on disk are dormant.

**Why parked:** The current design stores plaintext secrets on the shared
backend VM, which the user explicitly rejected ("secrets.json is on our
servers — I don't want this"). The replacement design isn't small enough
to ship alongside Phase B, so secrets are hidden until we come back.

---

## Background: the two rejected designs

### Rejected Design A — Agent-as-vault

**Shape:** When the user creates/edits a secret in the panel, the frontend
sends a silent message to Claude containing the secret value plus a
written standard for how Claude should store it. Claude responds visibly.
On session restart, Claude is expected to "remember" or reload secrets
from wherever it chose to put them.

**Why rejected:**

1. **Plaintext proliferation.** A "silent" message is still a message. It
   lands in the session transcript, the WS frame ring buffer, Claude's
   context window, the SDK's on-disk conversation log, and any
   replay/resume buffer. One file becomes many copies.
2. **LLM-as-vault has no determinism.** Claude is non-deterministic. A
   later message can cause it to paste the secret back into chat. A file
   the backend controls doesn't have that failure mode.
3. **Session restart doesn't work that way.** A new session is a fresh
   context. Claude doesn't carry secrets forward from a prior session
   unless we replay old messages (replaying plaintext into every new
   session's transcript) or write them to a file (which is the thing we
   were trying to avoid).
4. **"The agent saved it correctly" is load-bearing trust.** If Claude
   decides to `echo $SECRET > /tmp/notes`, we have no recourse.

Useful pieces to keep from this proposal:

- **Written standard for how secrets are exposed to the agent** — the
  agent needs to know *which* secrets exist so it can ask for them. This
  survives into the accepted design below.
- **Notification on create/edit** — the active session can be pinged
  when a new secret becomes available, as long as the ping carries the
  *name*, not the value.

### Rejected Design B — Server-side encrypted vault

**Shape:** Keep `~/.spaiglass/secrets.json` but encrypt it at rest with a
passphrase the user enters per session, or a key from a host keyring.

**Why rejected:** Still puts the ciphertext on the shared backend VM. The
user's constraint is "not on our servers," not "encrypt what's on our
servers." Encryption at rest helps against cold-disk theft but not against
a live VM compromise, and the user's threat model is the VM itself.

---

## Accepted Direction — Client Vault (implement later)

**Shape:** Secrets live in the browser (IndexedDB), encrypted with a key
derived from a master password only the user knows. The backend never
sees plaintext, never persists ciphertext, never sees the master password.

### Flow

1. **SecretsPanel** is a frontend-only CRUD surface over IndexedDB. On
   first use, the user sets a master password; subsequent browser sessions
   prompt to unlock.
2. **Encryption at rest:** WebCrypto SubtleCrypto with AES-GCM, key
   derived from the master password via PBKDF2 or Argon2id. Plaintext
   only exists in JS memory while the vault is unlocked.
3. **On WebSocket connect**, the frontend sends the list of available
   secret *names* (no values) to the backend. Backend holds this list in
   session state.
4. **On session start**, backend injects those names into Claude's system
   prompt: "You have access to these secrets via the `get_secret` tool:
   `openai_key`, `github_pat`, ..."
5. **When Claude calls `get_secret("github_pat")`**:
   - Backend sees the tool call, forwards a request to the browser over
     WS: "session needs secret `github_pat`".
   - Browser decrypts the value from IndexedDB, sends it back over WS.
   - Backend passes the value to Claude as the tool's result.
   - Backend holds the value in RAM only for the duration of the tool
     call, zeros it after.
6. **SecretsPanel create/edit** updates IndexedDB directly. If a session
   is active, frontend sends a `secret_available` notification to the
   backend with the name so Claude's system prompt gets updated (or a
   mid-session "new secret available: X" message is injected — name
   only).
7. **Session ends or browser closes:** Backend has nothing to persist
   because nothing was persisted in the first place.

### Transport encryption

Already covered. Tailscale encrypts end-to-end via WireGuard regardless
of whether the app uses `ws://` or `wss://`; the relay additionally
terminates TLS. No new work needed on the wire.

### The "browser closed" tradeoff

If the user's browser disconnects while a Claude session keeps running
(long builds, etc.) and Claude tries to call `get_secret`, the tool call
has to fail or wait. Two postures:

- **Strict (recommended default):** Tool call fails with "secret
  unavailable — user disconnected". No copy of the secret exists outside
  the browser. Claude works around it or waits.
- **Session-cached (opt-in later):** On first `get_secret` success,
  browser optionally pushes the value into backend RAM for the rest of
  the session's lifetime. Survives user disconnect. Zeroed on session
  end. A memory dump of the backend process during an active session
  would reveal the cached values — strictly weaker than strict mode.

Start strict. Loosen only if real workflows break.

### Multi-device question (open)

If the user sets a secret on their laptop, should it appear on their
iPhone? Two answers:

- **No:** each browser has its own independent vault. Simplest. Requires
  the user to re-enter secrets per device.
- **Yes:** the encrypted ciphertext blob syncs through *somewhere*.
  Options: user's own storage (Dropbox, Git), backend hosting the blob
  (still plaintext-free but reintroduces a shared-storage dependency),
  or a dedicated sync service. Each has its own attack surface.

No decision made. Revisit when the vault is built.

### What to delete when this ships

- `backend/handlers/secrets.ts`
- `~/.spaiglass/secrets.json` (with a migration that offers to export
  existing entries into the new client vault once during transition)
- `/api/secrets` routes in the router
- Current `SecretsPanel.tsx` CRUD flow (rewrite against IndexedDB, not
  the HTTP API)

### What to build

- `frontend/src/vault/clientVault.ts` — IndexedDB + WebCrypto wrapper
- `frontend/src/vault/useVault.ts` — React hook for unlock/lock/list/get/set
- `frontend/src/components/SecretsPanel.tsx` — rewritten UI
- `frontend/src/components/VaultUnlockModal.tsx` — master password prompt
- `backend/mcp/get-secret-tool.ts` — MCP tool that forwards to the browser
- `backend/session/secret-broker.ts` — backend-side request/response router
  between MCP tool calls and the WS frame carrying the value
- New WS frame types: `secret_request`, `secret_response`, `secret_available`

### Written standard (what Claude sees)

Part of the per-session system prompt, injected by the backend:

> You have access to user-provided secrets via the `get_secret(name)`
> tool. Available names for this session: `name1`, `name2`, `name3`.
> Guidelines:
>
> - Call `get_secret` only when you actually need the value.
> - Do not repeat secret values in your responses.
> - Do not write secret values to files unless the user explicitly asked
>   for that.
> - Do not include secret values in tool inputs except the specific tool
>   argument that requires them.
> - If a secret you expect isn't in the available list, ask the user to
>   add it via the Keys panel rather than prompting for the value in chat.

The guidelines are soft — Claude can technically violate them — but they
set the norm, and because values never hit the chat context unless
Claude explicitly quotes them, the blast radius of a violation is small.

---

## Open items for when we come back

1. **Multi-device sync:** yes/no, and if yes, where does the ciphertext
   live.
2. **Strict vs session-cached fallback:** default strict, revisit if it
   bites.
3. **Migration from the dormant `~/.spaiglass/secrets.json`:** one-time
   export flow, or just wipe it.
4. **Master password recovery:** no recovery is the simplest answer — if
   you forget it, the vault is gone and you re-enter your secrets. Any
   recovery mechanism reintroduces a trust root somewhere.
5. **Tie-in with `prompt_secret` MCP tool:** if Claude prompts for a
   secret interactively, should the widget offer a "save to vault"
   checkbox? Would need to hand the value to IndexedDB instead of just
   returning it to Claude.
6. **Audit logging:** should the panel show a history of which session
   requested which secret and when? Useful for trust, but that log itself
   becomes a forensic target.

---

## Related files (current state)

- `backend/handlers/secrets.ts` — server-side CRUD, still functional,
  unreachable from UI.
- `frontend/src/components/SecretsPanel.tsx` — still present, no longer
  rendered (import commented out in `FileSidebar.tsx`).
- `frontend/src/components/FileSidebar.tsx` — Keys tab button and render
  branch removed. Other tabs (Tree, Context, Help) unchanged.
- `~/.spaiglass/secrets.json` — may exist on some hosts with stale data.
  Safe to delete manually; nothing currently reads it unless the hidden
  API routes are hit directly.
