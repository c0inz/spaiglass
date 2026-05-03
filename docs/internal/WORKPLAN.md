# SpaiGlass Workplan

**Last refreshed:** 2026-05-03
**Audience:** whoever picks up the next session.

This is the carry-forward list of known issues that didn't ship in the most recent polish pass. Items are ordered by what blocks what — the CI items are the keystone for everything below them.

---

## 🔴 CI / red-bar items (visible to anyone browsing the repo)

These have been failing for weeks; format-drift was hiding them until we cleared that gate. Top priority because the CI badge in the README is currently red and gates everything else (branch protection, auto-tagging, deploy automation).

### C1 — Backend Prettier format check

Status: red on every recent commit since the format pass committed.

Most recent check: `gh run list --repo c0inz/spaiglass --workflow ci.yml -L 1 --json conclusion,jobs` shows `Backend (22) > Format check (Prettier)` failing.

Fix: `cd backend && npm run format && git commit -am "chore(format): backend"`.

Time: 5 min.

### C2 — Frontend test failure (real product bug)

`frontend/src/terminal/frames/state.test.ts:299` — `assistant_message replacing an existing messageId replaces the row in place`. Asserts `state.rows.length === 1`, gets `2`. The reducer is not deduping by messageId.

Symptom in production: duplicate assistant turns rendered in chat when the SDK emits a refined message with the same id.

Investigation site: `frontend/src/terminal/frames/state.ts` — find the `assistant_message` case in `applyFrame()`, ensure existing rows with matching messageId are replaced not appended.

Time: 1-2 hours.

### C3 — Backend type check fails on Node 24

`backend/mcp/interactive-tools.ts` — `ZodString` (Zod v3) not assignable to `$ZodType` (Zod v4). The bundled `@anthropic-ai/claude-agent-sdk` has moved to Zod v4; the backend pins v3.

Fix options:

1. Bump backend Zod to `^4.0.0` and update any v3-specific syntax (likely minimal — Zod's API is mostly stable across the major).
2. Pin the SDK to a Zod-3-compatible version.

Recommend option 1 — Zod 4 is the current series and we don't want to be one major behind permanently.

Time: 1 hour.

### C4 — Frontend `App.test.tsx` may need re-baselining

Removed the ProjectSelector test as part of the D1 deprecation (2026-05-03). The remaining test renders ChatPage at `/projects/test-path`. Verify it still passes after the rest of CI clears — it depends on a Brand-text matcher and a path-string check that should be stable, but worth a sanity pass.

Time: 15 min if it's clean, longer if it's actually red.

### C5 — `tagpr` workflow failing on every push

Auto-version-tagging is broken. Not investigated yet — could be related to CI prerequisites (it probably waits for green main) or a dep bump.

Time: unknown.

### C6 — No CD at all

`deploy-relay.sh` and `fleet-rollout-spaiglass.sh` run from a dev box, not in CI. Specified in `docs/operations/release-process.md` §12.

Prerequisites:

1. C1-C4 cleared so CI is green.
2. SSH deploy keys provisioned on a CI runner (or self-hosted runner inside the LAN).
3. Branch protection on `main` requiring CI pass.

Then write `.github/workflows/deploy.yml` that runs the same orchestrator the doc specifies.

Time: 1 day after prerequisites.

### C7 — No GitHub Releases tagged since v0.1.0

`v0.1.0` is from 2026-04-11. ~12 deploys since with no release tag — the repo's "releases" page reads as "this thing hasn't shipped in 3 weeks."

Plan: tag `v2026.05.03` once C1-C4 are green. Generate the changelog from `git log v0.1.0..HEAD`. Going forward, every fleet release also gets a GitHub release tag (covered in the release-process doc's §12).

Time: 30 min after CI green.

---

## 🟡 GitHub repo metadata (UI-only — needs you, not me)

My PAT lacks admin scope so I can't edit these via API.

### G1 — "About" sidebar still empty

In github.com/c0inz/spaiglass settings → General:

- **Description**: `Browser-based multi-VM interface for Claude Code — chat with Claude on your VMs from any browser, anywhere. Open source, end-to-end TLS, outbound-only, MIT licensed.`
- **Website**: `https://spaiglass.xyz`
- **Topics**: `claude-code` `claude` `anthropic` `ai` `llm` `websocket` `react` `typescript` `multi-vm` `self-hosted` `remote-development` `mit-license` `fleet-management` `wsl` `macos` `windows` `linux`

### G2 — Disable Wiki

Settings → Features → uncheck Wikis (it's empty; an empty wiki link reads as abandoned).

### G3 — License classifier should auto-flip to MIT

Was "Other" because of a non-standard second copyright line in the LICENSE file. Cleaned up 2026-05-03; GitHub's licensee crawler should re-read within ~24h. If not, force a re-read by editing LICENSE in the UI (re-save same content).

### G4 — Branch protection on `main`

Settings → Branches → add rule for `main`:

- Require status checks to pass before merging (after CI is green — gated on C1-C4)
- Require linear history (optional but nicer git log)
- Block force pushes

---

## 🟡 Dependabot PRs — 13 open, oldest 24 days

Strategy: merge the safe minor-bumps once CI is green, leave the major-bumps for explicit review.

### Safe to auto-merge once CI passes

- **#14** typescript 5.8.3 → 5.9.3 (frontend)
- **#13** esbuild 0.25.9 → 0.27.4 (backend)
- **#12** @typescript-eslint/eslint-plugin 8.44.0 → 8.57.2
- **#9** tsx 4.20.5 → 4.21.0
- **#8** rimraf 6.0.1 → 6.1.3
- **#6** typescript 5.9.2 → 5.9.3 (backend)
- **#4** eslint-plugin-react-refresh 0.4.20 → 0.5.2
- **#2** actions/setup-node 5 → 6
- **#1** Songmu/tagpr 1.9.0 → 1.17.1

### Major bumps — need review

- **#15** `@anthropic-ai/claude-code` 1.0 → 2.1 — **highest risk**, the SDK we depend on most heavily. Read the migration guide before merging. May intersect with C3 (Zod 4 transition).
- **#7** eslint-plugin-react-hooks 5 → 7 — usually safe but config syntax can change.
- **#5** actions/upload-artifact 4 → 7 — workflow YAML may need adjustment.
- **#3** @logtape/pretty 1 → 2 — backend logger; verify log output doesn't change shape.

---

## 🟡 Code-level deferred items

### D6 — `~/scripts/release-spaiglass.sh` orchestrator

Spec'd in `docs/operations/release-process.md` §10. Doesn't exist yet. The doc has a complete skeleton — implement it:

- Pre-flight gates (git clean, on main, CI green)
- Auto-version compute (UTC + suffix)
- Build via `deploy-relay.sh` with `SPAIGLASS_VERSION` env
- Health-check + smoke-test loop
- Fleet rollout via `fleet-rollout-spaiglass.sh`
- Out-of-inventory discovery
- Post-rollout heartbeat verification

~300-400 LOC bash. Half-day.

### D7 — `~/scripts/rollback-spaiglass.sh`

Spec'd in §9 of the release-process doc. Restores from `dist.tar.gz.bak-<timestamp>` + `VERSION.bak-<timestamp>` files the relay already keeps.

Half-day.

### D8 — Long-tail housekeeping

- **leagueofbeasty's `~/.claude.json` has a malformed second project entry** from earlier debugging. Cosmetic — picker dedups. Will clean on next `install.ps1` re-run on Windows. The unregister API was patched 2026-05-03 to accept Windows absolute paths, so it's also unblockable via API once the connector code rolls.
- **Bun binary vs Node-tarball update gap**: the fleet-rollout script updates `dist/` (Node path) but NOT the bun-compiled `spaiglass-host` binary. New code that ships in the connector source (`backend/connector.ts`) doesn't reach VMs running the Phase-3 bun binary until they re-run `install.sh`. **Implication**: connector-source changes must trigger an install.sh re-run on every VM, not just a fleet-rollout. Worth folding into the release-process doc and the orchestrator.
- **DevOps-VM's "primary NIC" reported wrong** — `collectSshHints()` ranking picked a non-primary interface on the dev box. Refine the heuristic. Not user-blocking.

---

## 🟢 Architecture / spec docs ready for review (not action-blocking)

- `docs/design/multi-harness-architecture.md` v0.2 — Qwen runtime + Provider abstraction. Complete, third-party-reviewed, ready for code work to begin (~9 days for MVP per phasing table).
- `docs/operations/release-process.md` v1 — release process spec, including the orchestrator skeleton.

Neither needs further review before implementation; both can be picked up by anyone.

---

## Recommended next-up order

When you sit down to take this on:

1. **C1** (5 min) — re-run backend prettier, push. Brings CI down to ~3 errors.
2. **C2** (1-2 hours) — fix the assistant-message dedup reducer bug. Real product bug; matters more than the CI badge.
3. **C3** (1 hour) — bump backend Zod to 4. Bonus: unblocks #15 dependabot.
4. After CI green:
   - **G1-G4** (5 min in GitHub UI)
   - **Dependabot triage** (30 min) — merge the 9 safe PRs in one batch
   - **C7** — tag `v2026.05.03` with cumulative changelog
5. **C6** — write `deploy.yml` for auto-CD on merge to main
6. **D6** — orchestrator script
7. **D7** — rollback script

That sequence puts the repo in a state where: green CI gates merges, releases auto-tag, the rollout pipeline is one command, and rollback is one command.

---

## Closed in this pass (2026-05-03)

For the record — what shipped before this workplan was written:

- **D1**: ProjectSelector route + component removed. Bare `/vm/<slug>/` redirects straight to first project.
- **D2**: Unregister API accepts Windows absolute paths (fixed handler bug).
- **D3**: Picker source badging is now unmistakable — emerald pill + project name for SpaiGlass rows, slate "Terminal" pill for CLI rows.
- **D4**: SoSatisfying + SocialDev hints populated; verified `vm_lan_ip` + `vm_ssh_user` + `vm_platform` in relay DB.
- **D5**: Sign Out button wired in Settings → General → Account section.

Plus the bigger pieces from this session:

- Self-healing connector watchdog (relay + connector ping/pong)
- Mac-mini darwin-arm64 binary published
- Flat global session picker with SpaiGlass / Claude-CLI source distinction
- Cwd-authoritative resume from picker
- Role file requirement deprecated
- 10-color favicon picker (with black eye on light backgrounds)
- Mobile three-step wizard (Server → Directory → Session)
- `<system-reminder>` blocks stripped from session previews
- Windows path basename split fix
- Server+Directory landing page deprecated; auto-redirect to chat
- DB-driven fleet rollout discovery (no more "out of inventory" VMs)
