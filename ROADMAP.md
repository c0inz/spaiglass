# SpAIglass Project Roadmap & Execution Plan

**Single source of truth for what we are doing and in what order.**

This document is the master execution plan for SpAIglass. It merges three previous documents (`ROADMAP.md`, `OpenSourceGitAssessmentWorkplan.md`, and the Phase 1 work-in-flight notes) into one place so any contributor — human or agent — can pick up where the last session left off.

It is informed by an external architecture review, an internal security audit of the live relay, and the project's core constraint: **this is a Claude Code product, not a generic agent platform.** We will go deep on Claude Code rather than wide on LLM abstraction.

_Last updated: 2026-04-10_

---

## How to use this document

- Phase numbers are stable identifiers. **Execution order is separate from phase numbers** and is set at the bottom of this file under "Active todo list → Execution order." As of 2026-04-10 the order is: **P1 → P2 → P3 → P4 → P6 → P8 → P9 → P7 → P5**.
- **Phases 1, 2, 3, 4, 6** are committed product engineering. P6 is the *last* product phase before the hardening/baseline tail. Don't start P6 until P1-P4 are shipped or unblocked.
- **Phases 8-9** are security hardening of the live relay (P8) and the documentation that ships with it (P9). P9 is doc-only and lands BEFORE P8's technical work.
- **Phase 7** is the open-source repo hygiene work (CONTRIBUTING/SECURITY/release/badges). Moved to second-to-last 2026-04-10. It is in flight on disk but is **not** blocking product work — finish it after the product+hardening phases are done.
- **Phase 5** (supply-chain hardening) is last. Moved to the bottom 2026-04-10. The original `Phase 8 → Phase 5` dependency on `/api/health` commit-SHA was resolved by pulling Phase 5 deliverable #8 forward into Phase 8 step 5 (John's call, option 2). Phase 5's #8 is now a verification checkbox.
- Every phase has a **"Done when"** contract. An item is not done until it meets it. No partial-credit shipping.
- When you complete a phase, update the date stamp at the top, mark the phase **shipped**, and add a CHANGELOG entry.
- When the priority order changes, edit this file and the date stamp in the same commit.
- Use this file to onboard a new agent: read it end-to-end, jump to the Execution order table, find the first non-shipped row, start at its first sub-step.

---

## Guiding constraints

These are decisions that should not be relitigated for any item below:

1. **Claude Code only.** No LLM-agnostic abstraction layer. The product's value is "Claude Code from anywhere," not "any model from anywhere." The code is open source — anyone who wants to run a different model is welcome to fork. We will not maintain a generic adapter ourselves.
2. **Minimally intrusive on the host.** Every host installer change must move toward smaller footprint, fewer prerequisites, and easier uninstall. New runtime dependencies on the host are an explicit non-goal.
3. **Bring your own key.** Users must be able to swap between Claude Max subscriptions and direct Anthropic API keys without reinstalling. No lock-in to a specific Anthropic billing model.
4. **Multi-user shared access from day one.** Spaiglass VMs are not single-tenant. Shared access (Phase 2) is a non-negotiable feature, not a backlog item.
5. **Open source and auditable.** Every change must keep the relay readable in an afternoon. New top-level dependencies in `relay/` need a written justification.
6. **Security claims must be honest.** If a guarantee has a footnote, the README and SECURITY.md state the footnote. We do not let marketing language get ahead of code.

---

# Phase 1 — Session resumption after disconnect

**Status:** not started. **Estimate:** 3-5 days. **Owner:** TBD.

This is the single largest UX gap in the product. Today, if a user closes their laptop or loses network mid-session, the Claude process on the host keeps running but the streaming output is lost forever. Reconnecting starts a fresh session. This breaks the "Claude from anywhere" promise the moment a user moves between networks.

It is also the foundation for Phase 2 (multi-user) — both depend on durable session IDs.

## Design (v1 — in-memory replay)

Start with the simplest design that fixes the user-visible problem. PTY-backed daemons can come later if v1 turns out insufficient.

1. **Session ID becomes durable.** Every `/api/chat` invocation gets a UUID assigned by the host backend on first message. The frontend stores it in the URL query string so the user can bookmark/refresh.
2. **Streaming output buffer.** The backend keeps a per-session ring buffer of NDJSON frames in memory, sized to the max Claude output we expect for one task (start at 4 MiB / ~20K frames). Each frame gets a monotonic cursor.
3. **Resume protocol.** When a browser reconnects, it sends `?since=<cursor>` with its last-seen cursor. The backend replays buffered frames from that cursor before resuming live streaming. If the requested cursor has fallen out of the buffer, the backend replies with `resume_lost` and the frontend prompts the user to view the conversation from `~/.claude/` history.
4. **Lifetime.** Buffers live for 30 minutes after the last frame is produced, then are GC'd. A still-running Claude process keeps its buffer alive indefinitely until it produces no new frames for 30 minutes.
5. **Survives backend restart?** v1 says no — buffers are in-memory. v2 (below) makes them disk-backed.
6. **Cancelation semantics.** The Stop button explicitly tears down the session and frees the buffer. We don't let buffers accumulate from impatient users who close tabs.

## v2 (later) — disk-backed sessions

Once v1 ships and we have telemetry on how often resume actually fires, decide whether to add disk persistence. Likely yes. Two options:

- **NDJSON spool file** per session under `~/.local/state/spaiglass/sessions/<id>.ndjson`. Replay reads from disk. Simple, no new deps, survives backend restart.
- **SQLite** with a single `frames` table. Better for concurrent access if we ever want multi-tab on one session. More structure than v1 needs.

Default to NDJSON unless a concrete need pushes us to SQLite.

## Non-goals for Phase 1

- Full PTY/tmux integration. Use case is "I closed my laptop," not "I'm running an interactive REPL."
- Multi-user concurrent attach to the same session. **That's a future-roadmap item, not Phase 2.** v1 here is single-attach: a second browser hitting the same session ID gets the replay and the first browser is dropped.
- Resume across host machine reboots. v2's spool file gets it as a side effect, not the goal.

## Done when

- Closing the browser tab during a Claude run, then reopening within 30 minutes, replays streaming output and continues live.
- Network drop (e.g., switching wifi) auto-reconnects without user action and replays only missed frames.
- Buffer never grows unbounded — unit test produces 100k frames and asserts memory stays flat.
- README "Features" section adds "Survives disconnect" as a top-level bullet.
- The session-ID infrastructure is documented well enough that Phase 2 can build on it without refactoring.

---

# Phase 2 — Multi-user collaboration (shared access)

**Status:** ✅ shipped (relay-side). **Owner:** done. **Depends on:** Phase 1.

> **Implementation notes (shipped):**
> - Schema: `vm_collaborators` keyed on `(connector_id, user_id)` (FK to `users.id`, not raw github_login — survives login changes), and `vm_audit_log` with actor/target user IDs.
> - The owner is **implicit** — `connectors.user_id` defines ownership, no row in `vm_collaborators`.
> - Single source of truth: `getConnectorAccess(connectorId, userId)` returns `'owner' | 'editor' | 'viewer' | null`. All permission checks consult it.
> - Viewer mode is enforced at the relay: HTTP layer rejects any non-safe method (POST/PUT/PATCH/DELETE), and the WS tunnel parses *only* the `type` field of each browser→VM frame to drop write-type messages (`message`, `interrupt`) and rewrite `session_start`/`session_restart` into a passive `resume` so a viewer can never spawn a Claude process.
> - The frontend hook (`useWebSocketSession`) captures the role from the relay's `connected` handshake and skips the resume→session_start fallback when the user is a viewer. Viewer UI binding lands when ChatPage migrates onto the WS hook.
> - Endpoints shipped: `GET /api/connectors` (now returns owned + shared), `GET/POST/PATCH/DELETE /api/connectors/:id/collaborators`, `GET /api/connectors/:id/audit`. Dashboard has a "Manage" modal and a "Shared with me" section.

**This has to exist.** Spaiglass VMs are not single-tenant. Today only the GitHub user who registered a connector can access it — there is no way to share a VM with a teammate, no concept of viewer-only access. This is a hard gap for any team use case.

Phase 2's committed scope is **shared access only**: each user gets their own session on the shared VM, with role-based permissions enforced at the relay. *Concurrent presence on the same session* (multiple users attached to the same session ID, typing indicators, input lock, per-message attribution) is **out of scope for this phase** — it's a future-roadmap item, see Backlog. We're not even sure Claude itself supports the concurrent-attach pattern at the API level; that needs verification before any future work.

## Identity, ownership, and permissions

- **Identity provider stays GitHub OAuth** (already in place).
- **Each VM has a primary owner** — the GitHub login that registered the connector.
- **Owners can add collaborators by GitHub login.** Collaborators see the VM in their dashboard and can act on it according to their role.
- **Three roles:**
  - `owner` — full control, can add/remove collaborators, delete the VM, regenerate tokens
  - `editor` — full read/write to chat sessions and the file editor; cannot add other users or delete the VM
  - `viewer` — read-only access to chat history and file browser; cannot send messages, cannot edit files
- **All permission enforcement happens at the relay** (the gatekeeper). The host backend trusts the relay — it does not re-check permissions. This is safe because the host only ever talks to the relay over the outbound WSS tunnel; an attacker can't bypass the relay without compromising it.
- **Audit log** records every grant, revoke, and role change.

## Schema changes

Add to the relay's SQLite (`relay/src/db.ts`):

```sql
CREATE TABLE vm_collaborators (
  connector_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (connector_id, github_login),
  FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
);

CREATE TABLE vm_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  action TEXT NOT NULL,
  target_login TEXT,
  metadata TEXT,
  occurred_at INTEGER NOT NULL
);
```

The connector owner is implicit — they're the `created_by` on the existing `connectors` table. They have `owner` role automatically without a row in `vm_collaborators`.

## Routing changes

The current URL `/vm/<owner-login>.<vm-name>/` keeps the owner login as the canonical identifier — simpler than introducing UUIDs and avoids breaking existing bookmarks. Collaborators access the same URL; the relay middleware checks:

```
isOwner(session_user, connector) OR
hasCollaboratorRole(session_user, connector, required_role)
```

For viewer access, the middleware also strips write-capable WebSocket frames before forwarding (or rejects them with a clear error). For editor and owner access, full bidirectional forwarding as today.

Each user gets **their own session** on the shared VM. Two collaborators do not share session IDs — each opens their own chat against the same Claude installation. This is the simple, well-defined model: shared *VM access*, not shared *session presence*.

## Dashboard UI

- "VMs shared with me" section listing connectors where the current user is a collaborator
- Per-VM "Manage collaborators" dialog (owner-only):
  - Add collaborator by GitHub login (autocomplete via GitHub search API)
  - Change a collaborator's role
  - Remove a collaborator
  - View audit log (last 30 days)
- Role badge next to each VM name (owner / editor / viewer)
- "Read-only" indicator in the chat input when accessing as viewer

## API additions

```
POST   /api/connectors/:id/collaborators          → add (owner only)
DELETE /api/connectors/:id/collaborators/:login   → remove (owner only)
PATCH  /api/connectors/:id/collaborators/:login   → change role (owner only)
GET    /api/connectors/:id/collaborators          → list (any role with access)
GET    /api/connectors/:id/audit                  → audit log (owner only)
GET    /api/shared-with-me                        → connectors I can access as collaborator
```

## Done when

- Owner can grant `editor` access to another GitHub user; the recipient sees the VM in their dashboard within 5 seconds.
- Recipient can chat against the VM with their own session, independent of the owner's sessions.
- Owner can demote `editor` to `viewer`; the recipient's UI updates without a page refresh and the chat input becomes disabled.
- Owner can revoke access; the recipient's WebSocket is force-closed and the VM disappears from their dashboard.
- All grants, revokes, and role changes appear in the audit log with timestamp and actor.
- A `viewer` cannot send messages or edit files even by crafting raw API requests (relay middleware enforces).

## Non-goals for Phase 2

- **Concurrent presence on the same session ID.** Two users attached to the same session, typing indicators, per-message attribution, input locks. Future roadmap, see Backlog. Needs validation that Claude even supports this pattern first.
- Real-time CRDT-based collaborative file editing (Yjs etc.). Backlog.
- Audio/video chat between collaborators. Different product.
- A separate user management system independent of GitHub. We use GitHub OAuth.
- Cross-VM permissions / org-level groupings. Possibly a future "v3" if user demand surfaces.

---

# Phase 3 — Single-binary host with no Node prerequisite

**Status:** ✅ shipped (binary build + installer rewrite). **Owner:** Claude.

## Implementation notes

- Unified entry point at `backend/cli/spaiglass-host.ts` boots the local
  backend then starts the connector in the same process. Replaces the
  legacy two-process layout (`node cli/node.js` + `node connector.js`).
- `bun build --compile --target=bun-<target>` produces a self-contained
  ~50 MB binary per platform. All 5 targets cross-compile from a single
  Linux host (`backend/scripts/build-binary.sh all`).
- Static frontend ships as a sibling `static/` dir next to the binary
  inside the per-platform tarball — bun-compile only bundles JS modules,
  so frontend assets travel alongside. `cli/node.ts` detects compiled
  mode (`__dirname` starts with `/$bunfs`) and resolves staticPath
  relative to `process.execPath`.
- `~/projects/<name>/agents/` auto-registration in `~/.claude.json`
  moved from `install.sh`'s inline `node -e` snippet into
  `backend/utils/register-projects.ts`, called from spaiglass-host
  startup. The installer no longer needs node at all.
- Per-platform tarballs at
  `https://spaiglass.xyz/releases/spaiglass-host-<target>.tar.gz`
  (relay route added with hard-coded allowlist of the 5 valid targets).
- Build matrix CI in `.github/workflows/host-binaries.yml` — fan-out
  on the 5 targets, attaches tarballs + sha256 checksums to draft
  GitHub releases.
- Risk that didn't materialize: bun's `node:child_process.spawn` works
  cleanly under the compiled binary — Claude Code CLI 2.1.101 was
  detected and version-checked end-to-end on the linux-x64 binary
  smoke test. The CLI script-path detection in `validation.ts` falls
  back to using the `claude` executable directly under bun (one
  warning, non-blocking).

**Original spec preserved below for reference.**

Today the host install requires Node >= 20, npm, and `npm install` of ~280 packages. On Windows this means asking users to install Node first. The reviewer's recommendation was a full Go/Rust rewrite. We are not doing that. Two cheaper paths achieve the same outcome:

## Path A (preferred) — `bun build --compile`

Bun compiles a TypeScript entry point + dependencies into a single self-contained executable for Linux/macOS/Windows. The output is one ~50 MB binary with no Node, no npm, no `node_modules`.

1. Add Bun as a build-time dependency (build only, never on the host).
2. New script `backend/scripts/build-binary.sh` runs `bun build --compile --target=bun-<platform>-<arch> cli/node.ts --outfile dist/spaiglass-host-<platform>-<arch>`.
3. Build matrix: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`. Five binaries per release.
4. CI builds and signs all five on every release tag.
5. `install.sh` and `install.ps1` simplified: detect platform, download the matching binary, drop it under `~/.local/bin/spaiglass-host` (or `%LOCALAPPDATA%\spaiglass\spaiglass-host.exe`), write the `.env`, install the per-user service that exec's the binary directly. **No `npm install` step at all.**
6. The Anthropic Claude Code CLI remains a separate prerequisite — outside our control, user already installs it.

**Risks:**
- Bun's compile target may not perfectly match Node's spawn semantics. Verify the Claude Code CLI spawn flow works under Bun before committing.
- Native modules (we don't currently use any in `backend/`) would need extra work. Audit before committing.
- Binary size ~50 MB vs current ~130 KB tarball + 100+ MB of `node_modules`. Net win on disk and download.

## Path B (fallback) — split connector as a Go binary

If Bun compile turns out unworkable, the smaller scope is to extract just the connector (the WebSocket dialer + reconnect logic) as a tiny Go binary, and keep the Claude-spawning backend in Node. The connector is the part that sits in memory full-time; the backend is only invoked when Claude is actually running. ~80% of the footprint win for ~20% of the rewrite cost.

This is the fallback, not the plan. Try Bun first.

## Done when

- A user with no Node, no npm, and no developer tools installed can run the one-line installer on a fresh Linux/macOS/Windows host and get a working SpAIglass host.
- `install.sh --uninstall` removes everything except the user's `.env` (which they should rotate anyway).
- The host install footprint on disk is under 100 MB (binary + service files + .env).
- README "Prerequisites" section drops the "Node.js >= 20" line.

## Non-goals

- Replacing the Anthropic Claude Code CLI. That's their binary; we spawn it.
- Full Go/Rust rewrite of the backend. Not happening.
- Cross-compiling from a non-Linux CI runner. We use GitHub Actions matrix builds.

---

# Phase 4 — Bring Your Own Anthropic Key

**Status:** not started. **Estimate:** 2 days. **Owner:** TBD.

Users today must have a Claude Max subscription on the host because that's how the Claude Code CLI authenticates by default. This locks out anyone who wants to use direct Anthropic API billing or who is on a different Claude tier.

## Design

1. **Settings UI gains an "Anthropic credentials" section.** Two modes:
   - **Use Claude CLI subscription** (default — current behavior, the CLI handles auth)
   - **Use Anthropic API key** — text input for `sk-ant-...`, stored encrypted at rest in the host's `.env`
2. **Backend respects `ANTHROPIC_API_KEY` env var** when spawning Claude. The Claude Code CLI already supports this — we just need to plumb the setting through to the spawn environment.
3. **Per-session override.** A user can set a key in the session URL or session metadata so different projects can use different billing accounts (e.g., personal vs company key).
4. **Key validation.** On save, hit `https://api.anthropic.com/v1/messages` with a one-token request to verify the key works before persisting.
5. **No relay involvement.** The key never leaves the host. The relay sees nothing.

## Done when

- A new user can install SpAIglass without a Claude Max subscription, paste an Anthropic API key in settings, and immediately start chatting.
- Switching between subscription and API key modes does not require a reinstall or restart.
- The relay continues to know nothing about which billing model any user is on.
- README "Prerequisites" section explicitly says "Anthropic Claude Code CLI installed and authenticated EITHER via subscription OR via `ANTHROPIC_API_KEY` env var."

## Non-goals

- Anything other than Anthropic. No OpenAI, no Gemini, no local models. Anyone who wants those should fork.
- Centralized key management. Each host owns its own key. The relay does not store keys and never will.

---

# Phase 6 — Rich terminal-style chat renderer

**Status:** scoped, not started. **Estimate:** ~3 weeks. **Owner:** TBD. **Depends on:** nothing strict, but **do not start** until P1-P4 are shipped or unblocked. (Phase 5 was moved to the bottom 2026-04-10; it is no longer a P6 prerequisite.) This is the last *product* phase before the hardening/baseline tail by explicit decision.

**Decision: replace the existing renderer wholesale. No parallel render paths, no feature-flagged dual maintenance after the cutover.**

## Goal

Replace the current React component tree that renders Claude's NDJSON message stream (`ChatMessages.tsx`, `useMessageProcessor.ts`) with a single terminal-style interpreter that produces rich, declarative output. Match the visual fidelity of Claude's native CLI while adding browser-only capabilities (clickable approval buttons, masked secret input, copy-to-clipboard).

The full WebSocket protocol contract for this layer lives in `agent-terminal-json.md` (the "Ink" Layer Contract). That file is the canonical schema both the React frontend and the host backend MUST conform to. This phase implements both ends of that contract.

## What we want to render

Listed in priority order. Every item in this list is committed scope.

1. **Colors** — ANSI 16-color and 256-color palette, mapped to our 6 themes
2. **Syntax highlighting** — Code blocks in any language Claude returns
3. **Spinners** — While Claude is "thinking" or a tool is in flight
4. **Tool-call cards** — Bash command + output, file Read/Edit/Write previews, search results, with the tool name, args, and exit status visually grouped
5. **Task checklists** — Claude's TodoWrite tool output rendered as live-updating checklists (✓/⊙/○)
6. **Progress updates** — Long-running tools (Bash with streaming stdout, multi-step operations) show running status
7. **ASCII grids of data** — Tables, file trees, anything box-drawn — render in monospace verbatim
8. **Masked secret input** — When Claude needs an API key or password, a `<input type="password">` field; the value is returned via the `tool_result` event and immediately wiped from the DOM
9. **Approval buttons** — Inline "Approve / Reject" buttons for risky operations (with diff/merge views for file changes)
10. **Persistent message history** — Survives refresh (pairs naturally with Phase 1)

## Renderer architecture: custom React components, no Ink dependency

After considering Ink, we're building our own small React component library instead. Rationale:
- Ink targets ANSI terminals via Yoga; using it in the browser requires writing a custom reconciler, which is complex and would lock us into Ink's component vocabulary.
- Our render target is the DOM, not ANSI. We get free flexbox, free hover/click, free a11y semantics.
- We control the abstraction. New Claude message types map to new components without fighting an upstream library.
- Smaller dependency footprint (in line with constraint #5: keep the codebase auditable).

Build a small `frontend/src/terminal/` library of components:

| Component | Purpose |
|---|---|
| `<TermBox>` | Flexbox container with optional ASCII border |
| `<TermText color="green">` | Colored monospace text, theme-aware |
| `<TermSpinner />` | Animated frame cycle |
| `<TermProgressBar value={0.4} />` | Long-running operation progress |
| `<TermChecklist items={...} />` | TodoWrite renderer |
| `<TermCodeBlock language="rust">` | Syntax-highlighted code via Shiki |
| `<TermToolCard tool="Bash" args={...} status="running">` | Tool-call card with streaming output area |
| `<TermTable rows={...}>` | ASCII grid renderer |
| `<TermDiff before={...} after={...}>` | Diff/merge view for `tool_permission` write_file events |
| `<TermInput masked />` | Interactive masked input — implements `prompt_secret` |
| `<TermButton onApprove onReject>` | Interactive approval — implements `tool_permission` |
| `<TermChoice options={...}>` | Multi-choice prompt |

A new module `frontend/src/terminal/interpreter.ts` consumes the WebSocket NDJSON stream defined in `agent-terminal-json.md` and produces a React component tree. It replaces the rendering side of `useMessageProcessor.ts`.

## Interactive widgets: implemented as MCP tools on the host backend

This is the **single biggest feasibility question** and 6.0 must answer it before committing to the full scope.

Claude in non-interactive streaming mode (which spaiglass uses) does **not** pause for user input mid-stream — it generates a response, then ends. So "ask for a masked secret" can't just be a UI element; it has to be a *thing Claude can call and wait for*.

The mechanism is **MCP tools we register with the spawned Claude Code CLI** on the host backend:

- `request_user_input(prompt, masked: bool)` — Claude calls it, host backend forwards to the frontend via the WebSocket as a `prompt_secret` event (see `agent-terminal-json.md`), frontend renders `<TermInput>`, user submits, value comes back as a `tool_result` event and is returned to Claude as the tool's return value.
- `request_approval(action, target, risk_level, context)` — Same flow, emits `tool_permission` event, returns `"approved"` or `"rejected"`.
- `request_choice(prompt, choices[])` — Same flow, returns the chosen value.

This is architecturally clean because:
- Claude already knows how to wait for tool results — that's the entire point of tool use
- The frontend already knows how to render arbitrary tool-call cards — these are just special cards with input
- No changes needed to Claude itself or to the streaming protocol
- Works with both Claude Max subscription and BYO Anthropic key (Phase 4)

**Three risks the spike must validate:**
1. The host backend can register custom MCP tools with the spawned Claude Code CLI process. (Almost certainly yes — MCP is Claude Code's extensibility point.)
2. Claude will actually call our `request_user_input` tool when prompted to ask for a secret. May need a system-prompt addition: *"When you need a secret value or approval, call the request_user_input or request_approval tool — never ask in plain text."*
3. The round-trip latency through the WebSocket is acceptable. (Should be — same WebSocket as everything else.)

If 6.0 fails on any of these, rich rendering still ships — only interactive widgets (`<TermInput>`, `<TermButton>`, `<TermChoice>`) get cut and move to the backlog with "blocked on Anthropic native support."

## Theming

The current theme system has 6 themes (including the 70s CRT phosphor). The new renderer:
- Maps ANSI 16-color to each theme's palette
- Honors the existing theme switcher (no separate "terminal theme")
- Keeps the CRT phosphor theme's 5-color picker working — those colors override the ANSI palette

## Persistence

Pairs with Phase 1's session resumption. The message stream is already buffered (Phase 1 ring buffer). When the frontend reconnects, it replays the buffer through the new interpreter. No additional work, just a clean integration point.

## Phased delivery

### 6.0 Spike — feasibility validation (3 days, GATE)

Before committing to full scope, validate the three risk assumptions above:

1. Stand up an MCP tool registration in the host backend that exposes `request_user_input(prompt, masked)`.
2. Prompt Claude with a task that should require user input ("Run a deploy script that needs an API key — ask me for it").
3. Confirm Claude calls the tool, the host backend can intercept, and we can return a value that Claude uses.
4. Document yes/no on each of the three risks in a one-page report.

**Done when:** the report exists and the team has decided whether 6.4 (interactive widgets) is in or out.

### 6.1 Core component library (5 days)

Build the `frontend/src/terminal/` non-interactive components without yet touching the existing renderer. Storybook (or equivalent) for visual testing. Ship:
- `<TermBox>`, `<TermText>`, `<TermSpinner>`, `<TermProgressBar>`
- `<TermChecklist>`, `<TermCodeBlock>` (syntax highlighting via Shiki)
- `<TermToolCard>`, `<TermTable>`, `<TermDiff>`
- (Interactive components deferred to 6.4)

**Done when:** every component renders in isolation across all 6 themes without visual regressions. Storybook deployed.

### 6.2 Interpreter behind a feature flag (3 days)

Build `interpreter.ts` to consume the existing stream and produce a component tree using the 6.1 components. Mount it behind `?renderer=terminal` so we can A/B test on real conversations.

**Done when:** the new interpreter renders the same conversation history as the old renderer for at least 20 saved test conversations covering: tool use, code blocks, todos, long Bash output, multi-turn dialogue.

### 6.3 Replacement (3 days)

Delete the old `ChatMessages.tsx` rendering path and the rendering side of `useMessageProcessor.ts`. The new interpreter becomes the only render path. Remove the feature flag. Update tests.

**Done when:** `git grep ChatMessages` returns nothing in the rendering layer; new renderer is default; all snapshot tests updated.

### 6.4 Interactive widgets (4 days, depends on 6.0 going green)

Implement the interactive components and the MCP tool plumbing per `agent-terminal-json.md`:
- Host backend registers `request_user_input`, `request_approval`, `request_choice` MCP tools
- Tools emit the `prompt_secret` / `tool_permission` events to the active WebSocket session
- Frontend renders `<TermInput>` / `<TermButton>` / `<TermChoice>` and wires submit/click back through the WS as `tool_result` events
- Add a system prompt fragment instructing Claude to use these tools rather than asking inline
- Secret values are wiped from the DOM immediately after submission

**Done when:** a test prompt that asks Claude to "ask for an API key, then echo a hash of it" triggers the masked input UI, accepts a value, and Claude proceeds with the value without ever putting the secret in plain message text.

### 6.5 Polish & migration (3 days)

- Theme integration polished across all 6 themes
- Copy-to-clipboard buttons on code blocks and tool cards
- Smooth scroll-to-bottom while streaming
- Performance pass: ensure new renderer is at least as fast as old one on a 1000-message scrollback test
- README screenshots updated; CHANGELOG entry

**Done when:** README screenshots updated; visual regression tests pass.

## Phase 6 done when

- The old `ChatMessages.tsx` renderer is gone.
- A normal Claude conversation in the spaiglass UI shows: themed colors, syntax highlighting, spinners during tool use, tool-call cards with running/done state, TodoWrite as live checklists, ASCII tables/grids verbatim.
- A Claude conversation that needs a secret API key triggers a masked input field; the secret never appears in chat history or relay logs.
- A Claude operation that needs approval shows clickable Approve/Reject buttons with diff views where applicable.
- All 6 themes work without visual regressions.
- Performance is at least as good as the old renderer on the 1000-message scrollback test.

## Non-goals for Phase 6

- Rich text editing inside the terminal renderer (it's read-only output + interactive widgets, not a text editor)
- Animations beyond simple spinners and progress bars
- Real terminal emulation via xterm.js (we considered it; rejected because interactive widgets are awkward to overlay)
- Mobile-optimized layout (the render is monospace and scrolls; mobile users get the same view)
- Backwards compatibility with the old renderer (deleting it is the point)

## Open questions

1. Should the renderer be a React component library or a separate package? Default: in-tree under `frontend/src/terminal/`, refactor to a package only if a second consumer appears.
2. Syntax highlighting via Shiki (large bundle, beautiful) or Prism (small bundle, less coverage)? Default: **Shiki** — this is a power-user product, fidelity beats bundle size.
3. Do approval buttons time out? Default: **5 minutes, then auto-reject**, configurable per tool call.

(The MCP-tool feasibility question — can the host backend register tools that pause Claude until the frontend responds — is the explicit gate of the 6.0 spike, not an open question.)

---

# Phase 8 — CSP and frontend integrity

**Status:** not started, but the design decision is **now** because audit findings make this urgent. **Estimate:** 1-2 weeks (now includes ~1 hour of `GIT_SHA` plumbing pulled forward from Phase 5). **Owner:** TBD.

> **Dependency resolved (2026-04-10):** Phase 5 was moved to the bottom of the execution order, which would have left Phase 8 step 5 stranded waiting on the `/api/health` commit-SHA work from Phase 5 deliverable #8. **John's call: option 2 — pull deliverable #8 forward into Phase 8.** The 1-hour `GIT_SHA` plumbing now lives inside Phase 8 (see step 5 below). Phase 5 deliverable #8 has been retitled as a cross-reference pointing back here. Phase 8 ships as a complete unit with all 5 steps.

This is the most under-disclosed risk in the project today.

## Live audit findings

```bash
$ curl -sI https://spaiglass.xyz/ | grep -iE "content-security|strict-transport|x-frame|x-content|referrer|permissions-policy"
(no output)
```

| Check | Result |
|---|---|
| `Content-Security-Policy` | **Missing** |
| `Strict-Transport-Security` | **Missing** |
| `X-Frame-Options` | **Missing** |
| `X-Content-Type-Options` | **Missing** |
| `Referrer-Policy` | **Missing** |
| `Permissions-Policy` | **Missing** |
| SRI hashes on script tags | **None** |
| Frontend bundle signing/verification | **None** |
| Inline scripts injected by relay | Two (`makeInjectScript`, `makeVersionSkewScript` at `relay/src/server.ts:1664-1672`) — both would conflict with strict CSP unless given nonces |

## The threat-model asymmetry

The README rightly claims the relay forwards WebSocket frames without inspection. That's true at the routing layer. But the relay also *originates* the JavaScript that runs in the user's browser, and that JavaScript reads chat input *before* it ever becomes a WebSocket frame. **A compromised relay doesn't need to inspect frames — it can replace the frontend bundle and silently exfiltrate everything users type.** The README does not state this trust assumption today.

## What CSP and SRI actually buy

**Content-Security-Policy** is a browser-enforced allowlist for what the page can load and execute. A strict CSP defends against:
- XSS where an attacker injects `<script>` via a parameter or stored content
- Malicious third-party scripts loaded transitively
- A subset of MITM attacks where injected scripts come from elsewhere

CSP does NOT defend against:
- A compromised origin serving its own malicious JavaScript with the right nonce
- Anything the relay itself decides to ship — the relay generates the CSP header

**Subresource Integrity (SRI)** is a per-script hash check (`<script src="..." integrity="sha384-...">`). The browser refuses to execute a script whose hash doesn't match.

SRI defends against:
- An asset CDN being compromised independently of the origin HTML
- MITM injection of tampered assets when origin HTML is fine

SRI does NOT defend against:
- A compromised origin that updates both HTML and integrity hash to match its new malicious payload

## The hard truth

**Neither CSP nor SRI protects against a compromised relay.** Both protect against attackers *other than* the origin operator. If someone owns the droplet, they can serve any JavaScript with any CSP and any SRI hash, and the browser will execute it.

The realistic defenses against a compromised relay are:

1. **Make the deployed bundle independently verifiable.** A user (or their security tool) should be able to ask: "what bundle is the live relay serving right now?" and compare against a public list of legitimate bundles tied to specific commits. Requires:
   - `/api/health` returns the commit SHA AND the hash of the served frontend bundle (now implemented inside this phase, step 5 — see option 2 resolution above)
   - Public release notes record the bundle hash for each release
   - Sigstore attestation ties each release's bundle hash to the CI workflow that built it
   - Anyone can `gh attestation verify` against the live hash without trusting us
2. **Self-hosting** for paranoid users. Their threat model becomes "do I trust myself."
3. **Honest README.** State the trust assumption explicitly.
4. **Defense in depth via CSP/HSTS/SRI.** Even though they don't stop a compromised origin, they raise the cost of every other attack class.

## Decision matrix

| Option | Stops compromised relay? | Stops XSS / MITM / 3rd-party? | Cost |
|---|---|---|---|
| **A. Strict CSP with nonces** | No | Yes | 1-2 days |
| **B. SRI on Vite assets** | No | Partial | Half day |
| **C. HSTS + standard hardening headers** | No | Partial | 1 hour |
| **D. Independent bundle verification** (depends on Phase 5) | **Yes** (detection) | Indirectly | 2-3 days |
| **E. Service worker hash pinning (TOFU)** | Partial (post-pin) | No | 1 week, complex |
| **F. Honest README amendment** | n/a — sets correct expectations | n/a | 1 hour |

## Recommended path

Do **A + B + C + D + F**. Skip E (complex, low marginal value once D is in place).

Order:

1. **F. Honest README amendment first** (1 hour). This is **Phase 9** — see below. Land it before any of the technical work in this phase. The documentation gap is the bigger problem right now.
2. **C. Standard security headers** (1 hour). Hono middleware applied to every relay response:
   - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY` (or `frame-ancestors 'none'` in CSP)
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Permissions-Policy: geolocation=(), microphone=(), camera=()`
3. **A. Strict CSP with nonces** (1-2 days). Refactor `tryServeFromRelayFrontend`:
   - Generate per-request nonce (`crypto.randomUUID()`)
   - Pass into `makeInjectScript` and `makeVersionSkewScript` so their `<script>` tags get `nonce="..."`
   - Set `Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-...'; connect-src 'self' wss://spaiglass.xyz; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`
   - Test with the live frontend, fix any console violations
4. **B. SRI on Vite assets** (half day). Add `vite-plugin-sri` to `frontend/`. Verify the relay's path-rewriting (`/assets/...` → `/vm/:slug/assets/...`) doesn't break SRI (it shouldn't — SRI is content-based).
5. **D. Independent bundle verification** (2-3 days; absorbs the ~1h `GIT_SHA` plumbing previously scoped to Phase 5 deliverable #8 — see option 2 resolution above):
   - **`GIT_SHA` plumbing (~1h, pulled forward from Phase 5):** set `GIT_SHA` at build time in CI (`echo "GIT_SHA=$(git rev-parse HEAD)" >> $GITHUB_ENV` or equivalent), read it via `process.env.GIT_SHA` in the relay, fall back to `"unknown"` if unset so dev builds don't crash.
   - `/api/health` returns `{"commit":"<GIT_SHA>","frontend_sha256":"<bundle hash>"}`. Compute the frontend bundle hash once at relay startup over the served `index.html` + asset graph; cache it.
   - Each GitHub release records the frontend bundle hash in its release notes (slot this into the Phase 7.6 release-notes skeleton when P7 ships).
   - Documentation explains how to verify the live relay matches a published release: `curl https://spaiglass.xyz/api/health` → compare `commit` and `frontend_sha256` against the release notes → `gh attestation verify` against the recorded hash.

## Done when

- `curl -I https://spaiglass.xyz/` returns CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
- The strict CSP is observed in browser dev tools without console violations on a normal session.
- `vite-plugin-sri` adds `integrity=` attributes to every script and stylesheet in the built `index.html`.
- SECURITY.md and README explicitly document the relay trust assumption and link to the verification procedure.
- A third party can run `curl https://spaiglass.xyz/api/health` and `gh attestation verify` to confirm what bundle is live.

## Non-goals

- Service worker pinning. Too complex for marginal value once D is in place.
- Chrome-only features like Trusted Types. Worth revisiting after CSP basics.
- Per-user nonce rotation. One nonce per response is fine.

---

# Phase 9 — Honest README & threat model amendment

**Status:** not started. **Estimate:** 1 hour. **Owner:** TBD. **Lands before:** Phase 8.

A doc-only pass. Numbered as a separate phase because it can ship independently of the technical hardening in Phase 8 and should not be blocked on it. It updates README.md, ARCHITECTURE.md, and SECURITY.md with these explicit additions:

1. **Trust model section in README.md**: state that using the hosted relay at `spaiglass.xyz` means trusting ReadyStack.dev to serve a legitimate frontend bundle. Link to the verification procedure (forthcoming in Phase 8 step 5).
2. **"Stateless" disclaimer in README.md**: change "stateless routing proxy" to "stateless for payload data; stateful only for the connector registry and collaborator permissions" once Phase 2 ships.
3. **Threat model expansion in ARCHITECTURE.md**: add a row for "compromised relay serves backdoored frontend" to the threat-model table, with the planned mitigation (Phase 8 step 5: independent bundle verification).
4. **Self-hosting promotion in SECURITY.md**: explicitly recommend self-hosting the relay for users who can't trust us.

## Done when

- README, ARCHITECTURE, and SECURITY all state the relay trust assumption explicitly.
- No security claim in the README is technically true only by sleight of hand.

---

# Phase 7 — Open-source baseline (in flight)

**Status:** in flight as of 2026-04-10. **Estimate:** 1-2 days to complete. **Owner:** TBD.

> **Execution-order note (2026-04-10):** moved to second-to-last by John. Phase numbering preserved; only the order in which work happens changes. Do not start Phase 7 sub-steps that require a green CI run until positional 1-7 (P1, P2, P3, P4, P6, P8, P9) are shipped. Sub-step 7.1 is already partially complete (baseline pushed in `3681296`); the failing CI it left behind is **paused** — see Active todo list at the bottom of this file.

This phase closes out the response to the external repository review that flagged: no `CONTRIBUTING.md`, no `SECURITY.md`, no released versions, no succession plan, single-contributor bus factor, missing CI badge. It also fixes the failing CI workflow inherited from upstream `claude-code-webui`.

It is intentionally **not** Phase 1. Product work outranks repo hygiene. Phase 7 lands when there is a natural seam — for example after Phase 1 ships, or in parallel as time allows. The baseline deliverables (CONTRIBUTING, SECURITY) already exist on disk, so the cost of leaving this in flight is small.

## What's already done (on disk, not yet committed)

- ✅ `CONTRIBUTING.md` — full contributor guide. Local dev commands, PR process, coding standards, bug report template, license grant.
- ✅ `SECURITY.md` — private disclosure to `security@readystack.dev`, response SLA, supported versions, scope, hardening notes for self-hosters.
- ✅ Prettier auto-fix applied to 9 backend files + 15 frontend files (the actual cause of failing CI — pure formatting, no semantic changes).
- ✅ Audit complete: upstream attribution / branding cleanup needed in 7 files (see 7.4).
- ✅ Decision: keep the inherited Deno tasks in CI for now (they work); fix `tagpr` after the package rename.

## 7.1 Commit baseline + fix CI

1. Stage the prettier-fixed files plus `CONTRIBUTING.md`, `SECURITY.md`, `ROADMAP.md`, and `agent-terminal-json.md`.
2. Do **not** stage `backend/static`, `relay/relay.db-shm`, or `relay/relay.db-wal` (runtime artifacts).
3. Commit message:
   ```
   Add CONTRIBUTING.md, SECURITY.md, ROADMAP.md, agent-terminal-json.md, fix CI prettier check

   - CONTRIBUTING.md: contributor guide (local dev, PR process, standards)
   - SECURITY.md: private disclosure to security@readystack.dev, SLA, scope
   - ROADMAP.md: consolidated execution plan (Phases 1-9)
   - agent-terminal-json.md: Ink Layer WebSocket protocol contract
   - Run prettier --write across backend/ and frontend/ to unblock CI
   ```
4. Push using the **classic PAT** at `~/credentials/github.json` (the fine-grained PAT lacks Contents: Write):
   ```bash
   PAT=$(jq -r .pat_classic_write ~/credentials/github.json) && \
     git push "https://c0inz:${PAT}@github.com/c0inz/spaiglass.git" main
   ```
   > **Gotcha (2026-04-10):** the `git -c "credential.helper=!f() { ... }; f"` form returns 403 even with a classic PAT that has full `repo` scope. Use the URL-embedded form above. Memory: `~/.claude/projects/-home-johntdavenport/memory/project_spyglass.md`.
5. Wait for CI to go green. If still red, fetch the failing job logs with `gh run view <id> --log-failed` and address before continuing.

**Done when:** the next CI run on `main` is fully green (all matrix entries passing).

## 7.2 Add `CODE_OF_CONDUCT.md`

- Use Contributor Covenant 2.1 verbatim.
- Replace contact placeholder with `conduct@readystack.dev`.
- `CONTRIBUTING.md` already links to it — verify the link resolves after the file lands.

**Done when:** file exists, linked from CONTRIBUTING.md and README.md.

## 7.3 Add `MAINTAINERS.md`

Short file. Structure:
- Primary maintainer: John Davenport (`@c0inz`) — ReadyStack.dev
- Backup contact: `jddavenpor46@gmail.com` (nominated 2026-04-10)
- Responsibilities: triage issues, review PRs, cut releases, operate the live relay at `spaiglass.xyz`
- Succession: if primary is unreachable for 30 days, the backup contact takes over via the procedure in `~/credentials/github.json` (which the backup must have access to)
- Maintainer GPG key fingerprint (for verifying signed commits) — TBD when first signed commit lands

**Done when:** file exists with the backup contact named, linked from README and CONTRIBUTING.

## 7.4 Branding and upstream attribution cleanup

The user said *"some of our code has the original author or should."* Audit findings:

| File | Issue | Action |
|---|---|---|
| `backend/package.json` | Named `claude-code-webui` v0.1.56, author `sugyan`, repo URL points to `sugyan/claude-code-webui` | Rename to `spaiglass-backend` v0.1.0, author `ReadyStack.dev`, repo `c0inz/spaiglass`, bin `spaiglass-backend`. Add attribution: `"Forked from sugyan/claude-code-webui"` in description. |
| `backend/cli/args.ts:27` | `.name("claude-code-webui")` and description `"Claude Code Web UI Backend Server"` | Rename to `spaiglass-backend` and `"SpAIglass host backend (forked from claude-code-webui)"` |
| `backend/utils/fs.ts:110` | Temp dir prefix `"claude-code-webui-temp-"` | Rename to `"spaiglass-temp-"` |
| `backend/history/pathUtils.ts:11` | Example comment `/Users/sugyan/tmp/` | Change to `/Users/alice/tmp/` |
| `frontend/src/utils/mockResponseGenerator.ts` | Demo paths `/Users/demo/claude-code-webui` (lines 46, 345, 438, 481, 673, 692) | Change to `/Users/demo/spaiglass` |
| `frontend/src/components/DemoPage.tsx:324` | `demoWorkingDirectory = "/Users/demo/claude-code-webui"` | Change to `/Users/demo/spaiglass` |
| `frontend/src/utils/storage.ts` | localStorage keys `claude-code-webui-*` | **Defer.** Renaming would orphan user settings. Add a TODO comment and revisit with a v2→v3 storage migration. |
| `LICENSE` | Already correctly attributes both ReadyStack and upstream | **No change** |

After making these edits: run `npm run typecheck` and `npm test` in `backend/` and `frontend/`. The package rename is the only risky change — verify nothing imports by package name.

**Done when:** `grep -r claude-code-webui` returns only the localStorage keys (with TODOs) and the LICENSE attribution line.

## 7.5 Fix or disable `tagpr` workflow

**Status:** decision deferred (2026-04-10). Do not act on this sub-phase until John explicitly chooses keep-and-fix vs disable. Phase 7 can still close around it — 7.5 is the only sub-phase that needs a directional call.

`tagpr` is upstream's release-PR automation and is currently failing on every run. Once 7.4 changes the package name, it will need a config update.

When the decision lands:
- **Keep-and-fix path:** update `.tagpr` (repo root) to point at the new package name and version path.
- **Disable path:** rename `.github/workflows/tagpr.yml` to `tagpr.yml.disabled` and add a note to `MAINTAINERS.md` that releases are cut manually.

**Done when:** decision recorded here AND either tagpr CI is green or the workflow is disabled.

## 7.6 Tag and publish v0.1.0

After 7.1-7.5 are merged and CI is green:

1. Annotated tag: `git tag -a v0.1.0 -m "v0.1.0 — first public release"`
2. Push the tag: `git push origin v0.1.0` (using the classic PAT helper)
3. Publish the GitHub Release with the body below, and attach these artifacts:
   - `relay/release/install.sh`
   - `relay/release/install.ps1`
   - `relay/release/dist.tar.gz`
   - `relay/release/VERSION`

**Release notes skeleton:**

```
SpAIglass v0.1.0 — first public release.

Highlights
- Cross-platform host support: Linux (systemd --user), macOS (launchd),
  Windows 10/11 (per-user Scheduled Task)
- One-line installers (install.sh, install.ps1)
- Stateless relay serving the React frontend; hosts ship a slim
  ~130 KB backend bundle
- Browser- and agent-driven enrollment via the relay dashboard
- GitHub OAuth + reusable agent API keys
- Six themes including 70s CRT phosphor with a 5-color picker

Security
- See SECURITY.md for the private disclosure process
- See ROADMAP.md Phase 8 for the CSP / frontend integrity hardening plan
```

**Done when:** v0.1.0 release is live on GitHub Releases with all four artifacts attached.

## 7.7 README badges + GitHub Discussions

Once 7.6 is shipped:

1. Add badges directly under the README title:
   ```markdown
   [![CI](https://github.com/c0inz/spaiglass/actions/workflows/ci.yml/badge.svg)](https://github.com/c0inz/spaiglass/actions/workflows/ci.yml)
   [![Release](https://img.shields.io/github/v/release/c0inz/spaiglass)](https://github.com/c0inz/spaiglass/releases)
   [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
   ```
2. Enable Discussions:
   ```bash
   PAT=$(jq -r .pat_classic_write ~/credentials/github.json)
   curl -s -X PATCH -H "Authorization: Bearer $PAT" \
     https://api.github.com/repos/c0inz/spaiglass \
     -d '{"has_discussions": true}'
   ```
3. Add a Community section to README:
   ```markdown
   ## Community
   - **Discussions:** https://github.com/c0inz/spaiglass/discussions
   - **Issues:** https://github.com/c0inz/spaiglass/issues — bugs and feature requests
   - **Security:** see [SECURITY.md](SECURITY.md) for private vulnerability reporting
   ```

**Done when:** badges render on the README, Discussions tab is visible on the repo.

## Phase 7 done when

- ✅ All seven sub-steps complete
- ✅ CI is green on main
- ✅ v0.1.0 is published with all artifacts
- ✅ All session tasks marked completed
- ✅ `OpenSourceGitAssessmentWorkplan.md` is deleted (this file replaces it)

---

# Phase 5 — Supply-chain hardening

**Status:** README mentions "planned." Now we ship it. **Estimate:** 1 week. **Owner:** TBD.

> **Execution-order note (2026-04-10):** moved to last by John. Phase numbering preserved; only the order in which work happens changes. **Conflict resolved:** the original `Phase 8 → Phase 5` dependency on the `/api/health` commit-SHA work was resolved with option 2 — deliverable #8 below was pulled forward into Phase 8 step 5. See Phase 8 step 5 for the actual implementation. Phase 5's deliverable #8 is now a verification checkbox, not new work.

The README's `Build & release verification` section already promises reproducible builds, SHA-256 checksums, signed commits, and Sigstore-backed artifact attestation. None of those are implemented yet. This phase closes the gap between what the README promises and what CI does.

## Concrete deliverables

1. **Pinned, locked dependencies.** Both `relay/package-lock.json` and `backend/package-lock.json` exist and are checked in. Verify. Use `npm ci` everywhere instead of `npm install`. CI fails if `package-lock.json` is out of sync.
2. **`npm audit` in CI.** Fail the build on high or critical advisories. Allow override per advisory with a comment justifying the suppression.
3. **SBOM generation.** Use `npm sbom --sbom-format=cyclonedx` on the relay and the host backend. Publish the SBOM as a release artifact.
4. **Sigstore-backed artifact attestation.** Use GitHub's `actions/attest-build-provenance` to attest the host binaries (post-Phase-3), the `dist.tar.gz`, and the relay frontend bundle. Verifiers run `gh attestation verify <file> --repo c0inz/spaiglass`.
5. **SHA-256 checksums file.** Every release publishes `checksums.txt` with hashes for every artifact. Signed by the same Sigstore identity.
6. **Reproducible builds.** Pin the build environment (Node version, npm version, OS image). CI runs the build twice on a clean runner and compares output hashes. Fail if non-reproducible.
7. **Signed commits on `main`.** Set up branch protection (separately) requiring signed commits for `main`. Document the maintainer GPG key fingerprint in `MAINTAINERS.md`.
8. **`/api/health` returns the deployed commit SHA.** ✅ **Pulled forward to Phase 8 step 5 (option 2 resolution, 2026-04-10).** This deliverable is now implemented as part of Phase 8 — it ships earlier in the execution order than Phase 5, so the work lives there. By the time Phase 5 starts, this is already done; verify it still works and check it off. No code changes required here unless something regressed.

## Done when

- Every step in the README's "Build & release verification" section is real and demonstrable, with example commands that actually work.
- A third party can independently verify that `https://spaiglass.xyz/dist.tar.gz` matches the bytes a CI build of commit `<sha>` would have produced, and was signed by our CI identity.
- `npm audit` is green on every PR.

## Non-goals

- Code signing certificates (Authenticode/Apple notarization). Sigstore attestation is sufficient for our threat model and doesn't cost $400/year. Revisit if a major distribution channel demands signed binaries.
- Reproducible builds for the frontend's `node_modules` graph as a whole. We pin and audit; we don't try to re-derive every transitive dep byte-for-byte.

---

# Out of scope (not happening)

These appear in the external review or other discussions. Documenting why so the question doesn't keep coming up.

| Item | Reason |
|---|---|
| LLM-agnostic abstraction layer (OpenAI, Gemini, local models) | Category error. This is a Claude Code product. The open-source license already lets anyone fork to add other models — that's the right channel. |
| Full Go/Rust rewrite of the backend | Months of work for marginal security gain. `bun build --compile` (Phase 3) gets the same footprint win in a week without throwing away the Claude SDK. |
| PTY-backed daemon for sessions | Reviewer's Phase 4. We start with the in-memory replay buffer (Phase 1). Revisit PTY only if v1 proves insufficient. |
| Generic phase tracker / `.ai/ACTIVE_TASK.md` workflow engine | Overly prescriptive. Not every Claude task fits a fixed pipeline. The existing `agents/*.md` system handles role definition lightweightly; that's enough. |
| Centralized credential / key management | Conflicts with the "relay knows nothing" guarantee. Each host owns its own keys. |
| Chrome extension or native desktop app | Browser-first is the entire point. Native apps are a different product. |
| Real-time CRDT collaborative file editing (Yjs etc.) | Too heavy for v1 multi-user. Backlog. |
| Audio/video chat between collaborators | Different product. |

---

# Backlog (no priority assigned, not committed to)

Items worth tracking but not on a clock:

- **Concurrent presence on the same session ID** (formerly Phase 2 v2). Multiple users attached to the same session, presence list, input lock, typing indicators, per-message attribution. **First open question: does Claude itself support concurrent attach to a single session at the API level?** This needs verification before any design work — it may not even be possible without us simulating the multiplexing on the host side. If feasible, the design notes are preserved here:
  - Per-tab `presence_id`, broadcast presence list to everyone on the session
  - Deterministic per-user color from `github_login`
  - Input lock acquired on Send, released at end-of-stream or 30s after disconnect
  - Typing indicators on a 500ms debounced channel
  - Per-message `github_login` attribution rendered in the UI
  - `active_sessions` table in the relay SQLite, GC'd on a 60s sweep
- **Org-level access and group-based collaborator management** (formerly Phase 2 v3). "Share with anyone in GitHub org X," team definitions, SSO beyond GitHub. Revisit after Phase 2 ships and we see what users actually ask for.
- Real-time CRDT collaborative file editing on top of any future concurrent-presence work
- Multi-tab attach to the same session as a single user (a degenerate case of concurrent presence)
- Webhook notifications when a Claude session completes
- Per-project Claude config presets (model, temperature, system prompt)
- Audit log export for security review
- Connector token rotation procedure (should be added to SECURITY.md regardless)
- Rate limiting on host-side API endpoints (currently only the relay rate-limits)
- SSO providers beyond GitHub (Google Workspace, Okta) — only if there's demand
- Anthropic API key rotation reminders / expiry tracking
- Per-VM resource budgets (max concurrent Claude processes, max tokens/day)

---

# Operational notes

## Auth & credentials

- The active `gh auth` token is a fine-grained PAT and **cannot push** — it lacks Contents: Write.
- For any `git push` or `gh release create`, use the **classic PAT** at `~/credentials/github.json` under key `pat_classic_write`. Memory persisted at `~/.claude/projects/-home-johntdavenport/memory/reference_credentials.md`.
- Never commit anything from `~/credentials/`.

## Files to never commit from this repo

- `relay/relay.db`, `relay/relay.db-shm`, `relay/relay.db-wal` — runtime SQLite of the local test relay
- `backend/static` — empty placeholder dir
- Anything under `relay/release/` is **safe** to commit; those are source artifacts the relay serves

## Live deployment

- The live relay at `spaiglass.xyz` runs from `/opt/sgcleanrelay` on droplet `137.184.187.234`. Deploys are `scp` + `systemctl restart sgcleanrelay`. None of the Phase 7 work requires touching the live droplet — all changes are repo-side.

## CI inheritance gotchas

- The CI workflow (`.github/workflows/ci.yml`) was inherited from `sugyan/claude-code-webui` and references things like `cli/deno.ts`, `runtime/deno.ts` which DO exist in the backend (also inherited). Don't aggressively trim it without checking.
- `tagpr.yml` is currently failing — see Phase 7.5.

## Open questions that need user input before specific phases ship

- **Phase 2:** should `viewer` role be able to see the file editor at all, or only the chat history? Default: full read-only file browser visibility, no edit.
- **Phase 4:** encrypt the host `.env` at rest (with what key) or rely on filesystem permissions? Default: filesystem permissions only.
- **Phase 6.0:** does the host backend's spawn of Claude Code CLI support custom MCP tool registration? **Spike must answer this before 6.4 is committed.**
- **Phase 7.3:** who is the backup maintainer in `MAINTAINERS.md`?
- **Phase 7.5:** keep `tagpr` (and fix the config) or disable it and cut releases manually?
- **Phase 7.4:** do storage key rename now (with v2→v3 migration) or defer? Default: defer.
- **Backlog — concurrent presence:** does the Claude Code CLI / Anthropic API even support concurrent attach to a single session? Verify before designing.

---

# How this document is maintained

- Items move from "not started" → "in flight" → "shipped" as work progresses.
- Priority order changes only by explicit decision, not by drift.
- "Estimate" is engineering-time, not calendar time.
- "Done when" is the contract. If you ship something that doesn't meet "Done when," you haven't shipped it.
- Date stamp at the top updates whenever priorities change.
- When a phase ships, write a CHANGELOG entry the same day.
- This file replaces and supersedes `OpenSourceGitAssessmentWorkplan.md`. Delete that file in the same commit that lands this one.

---

# Active todo list (current session)

Persisted here so it survives across Claude sessions. Update statuses when work starts or finishes.

## Execution order (set 2026-04-10)

Phase numbers are preserved from the original plan; only the **order in which work happens** changed when John moved Phase 5 to last and Phase 7 to second-to-last.

| Position | Phase | Title |
|---|---|---|
| 1 | P1 | Session resumption after disconnect |
| 2 | P2 | Multi-user collaboration (shared access) |
| 3 | P3 | Single-binary host with no Node prerequisite |
| 4 | P4 | Bring Your Own Anthropic Key |
| 5 | P6 | Rich terminal-style chat renderer |
| 6 | P8 | CSP and frontend integrity |
| 7 | P9 | Honest README & threat model amendment |
| 8 | P7 | Open-source baseline (in flight) |
| 9 | P5 | Supply-chain hardening |

**CI workflow fix (#47) is paused** — no work on it until positional 1-7 ship.

| # | Status | Phase | Task |
|---|---|---|---|
| 43 | ✅ completed | 7.0 | Add `CONTRIBUTING.md` |
| 45 | ✅ completed | 7.0 | Add `SECURITY.md` with private disclosure path |
| 47 | ⏸️ paused | 7.1 | Fix failing CI — baseline pushed in `3681296` but CI still red. Paused 2026-04-10 by John: do not work on this until positional 1-7 of the new execution order ship (P1, P2, P3, P4, P6, P8, P9). Two issues catalogued: (1) prettier version drift — local pins 3.6.2, CI installs 3.8.2 and reformats `backend/session/manager.ts` differently; (2) frontend lint has 34 inherited `no-explicit-any` errors in `mockResponseGenerator.ts`, `UnifiedMessageProcessor.ts`, and friends. |
| 44 | ⏳ pending | 7.2 | Add `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) |
| 46 | ⏳ pending | 7.3 | Add `MAINTAINERS.md` / succession plan — backup contact `jddavenpor46@gmail.com` confirmed; ready to write |
| 48 | ⏳ pending | 7.4 | Audit upstream attribution in source files (audit done, fixes not applied) |
| —  | ⏸️ deferred | 7.5 | `tagpr` workflow keep-or-disable — decision deferred by John 2026-04-10 |
| 49 | ⏳ pending | 7.6 | Tag and publish v0.1.0 release |
| 50 | ⏳ pending | 7.7 | Wire CI badge into README + enable Discussions |

## Uncommitted on disk right now

Nothing as of commit `3681296` (2026-04-10). The Phase 7.1 baseline is on `origin/main`.

## Blockers / questions waiting on user input

- **Phase 7.5 — `tagpr` workflow.** Keep and reconfigure after package rename, or disable and cut releases manually? Deferred by John 2026-04-10.
- **Phase 6.0 — MCP tool registration.** Spike must validate before 6.4 is committed. Not blocking anything right now since P6 is at the back of the queue.
