# SpaiGlass Release Process

**Status:** v1 — codifies the manual flow currently used; phase 2 is moving it into GitHub Actions.
**Audience:** anyone shipping a SpaiGlass change end-to-end (relay + fleet + binaries).
**Goal:** every release is deterministic, verifiable, and reversible. No release-by-vibes.

---

## 1. Goals

1. **One command, one outcome.** A single orchestrator script (`~/scripts/release-spaiglass.sh`) takes a clean main branch and produces: a versioned release on the relay, an updated fleet, fresh platform binaries for end-user installs, and a post-rollout health report. Every release follows the same path.
2. **All five supported targets covered every time.** Linux x64/arm64, Darwin x64/arm64, Windows x64. No skipping platforms because "I'm only on Linux right now." Cross-compile is the rule, not the exception.
3. **Fleet of test VMs converges automatically.** Whatever's currently deployed on the relay is what the 11 fleet VMs run, full stop. No drift between relay and fleet, no per-VM specials.
4. **Version determinism.** Every release has a unique, monotonically-ordered version string. No silent reuses of `2026.05.02` between two distinct deploys.
5. **Verification gates the next step.** Tests must pass before build; relay health must be green before fleet rollout; fleet heartbeats must verify before the release is declared shipped.
6. **Rollback in one command.** Any release can be reverted to the previous tarball + relay source state without manual archaeology.
7. **End-user platforms self-heal.** Windows + Mac users running `install.sh` / `install.ps1` always get the latest version. The release does NOT push to user machines (we don't own them); it ensures the relay always serves the right artifacts so user-initiated updates land cleanly.

## 2. Versioning scheme

`YYYY.MM.DD` UTC date, with a single lowercase letter suffix that auto-increments when more than one release ships in the same UTC day.

```
2026.05.02       first release of May 2 (UTC)
2026.05.02a      second release same UTC day
2026.05.02b      third
…
2026.05.02z      26th (in practice this never happens; if it does, error and prompt)
```

**Computation rule** — orchestrator queries the relay's current VERSION, parses the date and suffix, and picks the next:

```
relayVer=$(curl -s https://spaiglass.xyz/api/release | jq -r .version)
todayUTC=$(date -u +%Y.%m.%d)
if [[ "$relayVer" != "$todayUTC"* ]]; then
  next="$todayUTC"          # first release of UTC day
elif [[ "$relayVer" == "$todayUTC" ]]; then
  next="${todayUTC}a"
else
  letter="${relayVer: -1}"
  next_letter=$(echo "$letter" | tr 'a-y' 'b-z')
  next="${todayUTC}${next_letter}"
fi
```

**Override** — set `SPAIGLASS_VERSION` env var to force a specific value (used for hotfixes, testing, etc). Orchestrator validates the override doesn't go backwards.

**Never reuse a version.** Pre-flight check confirms the chosen version doesn't already exist on the relay.

## 3. Pre-release gates

Run in order. Any failure stops the release.

| Gate | Command | Skippable? |
|---|---|---|
| Working tree clean | `git status --porcelain \| grep -v '^??'` returns empty | No |
| On `main` branch | `git rev-parse --abbrev-ref HEAD == "main"` | No |
| Up to date with origin | `git fetch && git merge-base --is-ancestor HEAD origin/main` | No |
| Frontend lint + typecheck | `cd frontend && npm run lint && tsc -b --noEmit` | `--no-lint` |
| Frontend tests | `cd frontend && npm test -- --run` | `--no-test` |
| Backend format check (Deno) | `cd backend && deno task format:check` | `--no-lint` |
| Backend lint (ESLint + Deno) | `cd backend && npm run lint && deno task lint` | `--no-lint` |
| Backend typecheck | `cd backend && tsc --noEmit && deno task type-check` | `--no-lint` |
| Backend tests | `cd backend && npm test -- --run` | `--no-test` |
| Version not already published | `curl -s https://spaiglass.xyz/api/release \| jq -r .version != $TARGET_VERSION` | No |

`--no-test` and `--no-lint` are emergency-hotfix flags. Each triggers a confirmation prompt and is logged in the commit message footer.

## 4. Build matrix

Single command from the orchestrator:

```bash
SPAIGLASS_VERSION=<computed> bash relay/release/deploy-relay.sh
```

`deploy-relay.sh` is the canonical builder. It produces:

| Artifact | Source | Output | Used by |
|---|---|---|---|
| Frontend bundle | `frontend/` (vite build) | `frontend/dist/` | Served from relay's `/opt/sgcleanrelay/frontend/` |
| Backend Node bundle | `backend/` (esbuild) | `backend/dist/cli/node.js`, `backend/dist/connector.js` | Wrapped in `dist.tar.gz` for legacy npm-install path on fleet VMs |
| `dist.tar.gz` | `pack.sh` | `relay/release/dist.tar.gz` | Fleet rollout downloads from `/opt/sgcleanrelay/release/dist.tar.gz` |
| Linux x64 binary | `bun build --compile --target=bun-linux-x64-baseline` | `dist/spaiglass-host-linux-x64.tar.gz` | New fleet installs on Linux x64 |
| Linux arm64 binary | bun-linux-arm64 | `dist/spaiglass-host-linux-arm64.tar.gz` | Linux arm64 (e.g. Raspberry Pi, AWS Graviton) |
| Darwin x64 binary | bun-darwin-x64 + ldid sign | `dist/spaiglass-host-darwin-x64.tar.gz` | Intel Macs |
| Darwin arm64 binary | bun-darwin-arm64 + ldid sign | `dist/spaiglass-host-darwin-arm64.tar.gz` | Apple Silicon Macs |
| Windows x64 binary | bun-windows-x64-baseline | `dist/spaiglass-host-windows-x64.tar.gz` | Windows installs |
| Installers | `install.sh`, `install.ps1` (preserved as-is from repo) | Uploaded to relay | Linux/Darwin: `install.sh`; Windows: `install.ps1` |

Each platform tarball embeds a `VERSION` file matching `SPAIGLASS_VERSION` (see §11 — this was a real bug fixed 2026-05-01).

Darwin tarballs are pre-flighted on the build host: `unsign` magic-bytes verification confirms `ldid` signed them. Unsigned darwin binaries get SIGKILL on Apple Silicon — a release that ships unsigned darwin tarballs is broken.

## 5. Deploy sequence

`deploy-relay.sh` uploads in this order:

1. Frontend → `/opt/sgcleanrelay/frontend/` (NOT `/frontend/dist/` — relay reads index.html from this dir directly)
2. Relay source → `/opt/sgcleanrelay/src/`
3. Architecture manual → `/opt/sgcleanrelay/architecture/`
4. Backend tarball + `VERSION` → `/opt/sgcleanrelay/release/dist.tar.gz` and `/opt/sgcleanrelay/release/VERSION`
5. All 5 platform binary tarballs → `/opt/sgcleanrelay/release/spaiglass-host-*.tar.gz`
6. install.sh + install.ps1 → `/opt/sgcleanrelay/release/`
7. `systemctl restart sgcleanrelay`
8. Health probe loop (poll `/api/health` for up to 30s)
9. Smoke tests:
   - `curl -sI https://spaiglass.xyz/dist.tar.gz` returns `X-Spaiglass-Version: <expected>`
   - `curl -sI https://spaiglass.xyz/spaiglass-host-darwin-arm64.tar.gz` returns 200
   - `curl -fsSL https://spaiglass.xyz/install.sh | head -1` matches the local install.sh sha256

### Health-probe race

Known issue: `deploy-relay.sh` sometimes prints "Health check failed — relay not responding" even when the relay is healthy. The probe runs immediately after `systemctl restart` returns; the new process binds the socket ~1-2 seconds later. The orchestrator should retry the probe with backoff (3 attempts, 2s/4s/8s) and only flag failure if all three miss. This is a script-level fix, not a relay-level one.

## 6. Fleet rollout

Once relay is verified, push to test VMs.

### 6.1. Inventory VMs (10 of 11)

`~/scripts/fleet-rollout-spaiglass.sh --yes`

Reads its hardcoded inventory:

```
Fuzz, TomBombadil, Daniel, DevOps-VM, NFTHall, TheDezz,
UsaPrime, AgentEPC, SolarKnock, Trendzion
```

For each VM:
1. SSH (with appropriate ProxyJump for libvirt VMs)
2. Compare current VM `VERSION` against relay's
3. If mismatch: `curl -fsSL https://spaiglass.xyz/dist.tar.gz | tar -xzf -`, copy `backend/dist/` into place, bump `~/spaiglass/.env` `SPAIGLASS_VERSION`, restart `spaiglass.service`
4. Verify the connector re-authenticates against the relay (DB `last_seen` should refresh within 30s)

The script reports per-VM success/failure and exits non-zero on any failure.

### 6.2. Out-of-inventory VMs (currently: SoSatisfying)

The hardcoded inventory misses VMs registered after the script was last edited. The orchestrator must:

1. Query the relay DB:
   ```sql
   SELECT name FROM connectors WHERE last_seen > datetime('now', '-7 days');
   ```
2. Diff against the inventory list.
3. For each extra VM, run `install.sh` re-installation (idempotent — preserves `.env`, just upgrades the binary):
   ```bash
   ssh -o ProxyJump=<jump> <user>@<ip> \
     "curl -fsSL https://spaiglass.xyz/install.sh | \
      bash -s -- --token=<token> --id=<id> --name=<name>"
   ```
4. Token + id come from the relay DB, joined to the connector record:
   ```sql
   SELECT name, id, token FROM connectors WHERE name='SoSatisfying';
   ```

**Long-term fix:** make `fleet-rollout-spaiglass.sh` discover its inventory from the relay DB instead of hardcoding it. Then there are no "out of inventory" VMs.

### 6.3. SSH topology

Inventory script already knows the jump-host pattern:

| LAN segment | Jump | Notes |
|---|---|---|
| `192.168.1.x` (LAN) | none | Direct SSH from dev box |
| `192.168.122.x` on bombadil | `bombadil` | bombadil libvirt host |
| `192.168.122.x` on mombadil | `mombadil` | mombadil libvirt host |

The orchestrator must determine the jump host correctly for each VM. Today `fleet-rollout-spaiglass.sh` has a hardcoded mapping. Out-of-inventory expansion (§6.2) needs the same mapping logic — easiest is to extract it into a sourced bash function.

## 7. End-user platforms

Releases also serve users running on their own laptops, not on the test fleet. These platforms are self-served — users run install.sh / install.ps1 on demand; the release ensures the relay always serves the right artifacts.

### 7.1. macOS

```bash
curl -fsSL https://spaiglass.xyz/install.sh | bash -s -- \
  --token=<token> --id=<id> --name=<vm-display-name>
```

Auto-detects `darwin-arm64` vs `darwin-x64`. Pulls signed binary; ldid signature is verified at install time. Service installs as a `~/Library/LaunchAgents/xyz.spaiglass.vm.plist`. Re-running upgrades.

### 7.2. Windows

```powershell
iwr https://spaiglass.xyz/install.ps1 -useb | iex
# (then prompts for token/id/name interactively)
# OR scripted:
& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) `
  --token=<token> --id=<id> --name=<vm-display-name>
```

Pulls `windows-x64` binary. Service installs as a Windows Scheduled Task running at user login. Re-running upgrades.

### 7.3. Linux

Same as macOS path — `install.sh` auto-detects `linux-x64` or `linux-arm64`. Service installs as a `~/.config/systemd/user/spaiglass.service`. Requires `systemctl --user` to be functional (lingering enabled if running headless without a login session).

### 7.4. User update notification

The relay serves `X-Spaiglass-Version` and `X-Spaiglass-Frontend-Version` headers. The frontend SPA reads `__SG_VERSION` from page HTML and compares against the header on poll. Mismatch → "Update available" banner in the chrome. Users see this within ~30s of a release, *without* the release pushing anything to their machines. Update is then user-initiated by re-running `install.sh` / `install.ps1`.

This means: pushing a release is enough — no separate notification step is needed.

## 8. Post-rollout verification

After fleet rollout completes:

1. Query the relay's connector heartbeat status:
   ```sql
   SELECT name,
          (julianday('now') - julianday(last_seen)) * 86400 AS sec_ago
   FROM connectors;
   ```
2. **All connectors should be ≤120s old** (auth happens on reconnect, which fires within 60s of a connector restart). Any > 120s is suspicious.
3. Check active TCP sockets on the relay:
   ```bash
   ssh root@137.184.187.234 "ss -tn '( sport = :443 )' | wc -l"
   ```
   Expect at least N+1 connections (one per fleet VM + at least one browser).
4. Smoke a tunneled API endpoint to confirm relay → connector forwarding still works:
   ```bash
   curl -sI https://spaiglass.xyz/vm/<any-conn>/api/health   # via auth
   ```
5. **Frontend bundle hash check** (catches stale-cache / wrong-frontend-deployed cases):
   ```bash
   curl -s https://spaiglass.xyz/ | grep -oP '__SG_VERSION=\K[^;]+'
   # should match the released version
   ```

If any verification fails, the orchestrator marks the release as **Verified-Partial** and logs which checks failed. It does NOT auto-rollback (operator decides).

## 9. Rollback

The relay keeps backup copies of the previous frontend + tarball:

```
/opt/sgcleanrelay/release/dist.tar.gz.bak-<timestamp>
/opt/sgcleanrelay/release/VERSION.bak-<timestamp>
/opt/sgcleanrelay/frontend.bak.<timestamp>/
```

Rollback procedure (operator-initiated):

```bash
~/scripts/rollback-spaiglass.sh <target-version>
```

Steps:
1. Validate `<target-version>` exists in backups (or in git history at the corresponding commit).
2. Swap backup files into the live paths.
3. Restart sgcleanrelay.
4. Run fleet-rollout AS IF the target version is canonical — the script's diff-based logic will downgrade VMs to match.
5. Health-probe + post-rollout verify.

For deeper rollbacks (older than the last backup window), check out the corresponding git commit, re-run the orchestrator with `--version <target>` to rebuild + redeploy from source.

## 10. Orchestrator script (deliverable)

A single bash script `~/scripts/release-spaiglass.sh` that runs all of §3-§8 in order. Skeleton:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ----- args -----
TARGET_VERSION=""
SKIP_TESTS=0
SKIP_LINT=0
SKIP_FLEET=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --version=*)   TARGET_VERSION="${arg#*=}" ;;
    --no-test)     SKIP_TESTS=1 ;;
    --no-lint)     SKIP_LINT=1 ;;
    --no-fleet)    SKIP_FLEET=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# ----- §3 Pre-release gates -----
preflight_git
preflight_typecheck
[[ $SKIP_LINT -eq 0 ]] && preflight_lint
[[ $SKIP_TESTS -eq 0 ]] && preflight_tests

# ----- §2 Compute version -----
[[ -z "$TARGET_VERSION" ]] && TARGET_VERSION=$(compute_next_version)
preflight_version_unique "$TARGET_VERSION"

# ----- §4-§5 Build + deploy -----
[[ $DRY_RUN -eq 1 ]] && { echo "[dry-run] would deploy $TARGET_VERSION"; exit 0; }

SPAIGLASS_VERSION="$TARGET_VERSION" bash relay/release/deploy-relay.sh

# ----- post-deploy verify -----
verify_relay_health
verify_relay_version "$TARGET_VERSION"
verify_platform_tarballs "$TARGET_VERSION"

# ----- §6 Fleet rollout -----
if [[ $SKIP_FLEET -eq 0 ]]; then
  ~/scripts/fleet-rollout-spaiglass.sh --yes
  rollout_out_of_inventory "$TARGET_VERSION"
fi

# ----- §8 Post-rollout verify -----
verify_fleet_heartbeats
verify_fleet_version_match "$TARGET_VERSION"

# ----- summary -----
report_release "$TARGET_VERSION"
```

Each helper is a discrete function. Total length: ~300-400 LOC. Lives in `~/scripts/`, version-controlled in a separate ops repo or copy-checked into spaiglass under `relay/release/release.sh` for visibility.

### Behavior contract

- **Idempotent** — re-running with the same version returns "already shipped" without re-deploying
- **Atomic w.r.t. fleet** — the deploy-then-rollout sequence is a single unit; if rollout fails, the release is marked `Verified-Partial` and operator decides next step
- **Verbose logging** — every step prints what it's doing and the resulting state, with timestamps
- **Exit codes** — 0 = success, 1 = pre-flight fail, 2 = build fail, 3 = deploy fail, 4 = rollout fail, 5 = verification fail

## 11. Common pitfalls

These have all bitten us; the orchestrator handles them.

### 11.1. Local-tz vs UTC date in `build-binary.sh`

`scripts/build-binary.sh` previously used `date +%Y.%m.%d` (LOCAL timezone) for the embedded VERSION fallback. `pack.sh` used `date -u +%Y.%m.%d` (UTC). On UTC-day-boundary builds, the per-platform binary tarballs would stamp a different version than the slim `dist.tar.gz` and the relay's VERSION file.

**Fixed 2026-05-01**: `build-binary.sh` now honors `SPAIGLASS_VERSION` env first, falls back to `date -u`. The orchestrator MUST set `SPAIGLASS_VERSION` so all five binary tarballs + the slim tarball + the VERSION file all agree.

### 11.2. Frontend deploy path

Frontend deploys to `/opt/sgcleanrelay/frontend/`, NOT `/opt/sgcleanrelay/frontend/dist/`. The relay's `RELAY_FRONTEND_DIR` reads `index.html` from the top of that directory.

### 11.3. Darwin signing

Darwin binaries (`darwin-x64`, `darwin-arm64`) must be signed with `ldid` post-bun-compile or Apple Silicon SIGKILLs them on launch. `build-binary.sh` does this; `deploy-relay.sh` verifies the signature magic bytes before upload. Never bypass either step.

### 11.4. Windows binary path-prefix bug (now fixed)

`cli/node.ts`'s old auto-run guard checked `import.meta.dirname.startsWith("/$bunfs")`. Bun's compile virtual FS uses `B:/~BUN/...` on Windows, not `/$bunfs/`, so the guard returned false and the auto-run path fired *inside* the compiled binary, double-initializing Commander → `.version()` duplicate-flag crash on startup.

**Fixed 2026-05-01** with a `process.execPath` check that's platform-agnostic. Don't reintroduce path-prefix sniffing.

### 11.5. Connector `last_seen` semantics

`last_seen` in the relay's `connectors` table updates **only on auth/re-auth**, NOT on each ping. So a long-lived connector with no restart shows a stale `last_seen` even though it's actively heartbeating. Don't use `last_seen` as a liveness check past the first 60 seconds after deploy. Use `cm.isOnline(connectorId)` (in-memory) for true liveness, or `ss -tn` socket counts as a proxy.

### 11.6. SoSatisfying-style out-of-inventory VMs

The fleet inventory in `fleet-rollout-spaiglass.sh` is hardcoded. Any VM registered after the script was last edited gets skipped silently. The orchestrator must detect this (§6.2) and run `install.sh` separately for those VMs.

## 12. Phase 2: move it to GitHub Actions

The orchestrator is the manual baseline. The eventual goal is for `git push origin main` to trigger a workflow that runs identical steps without operator intervention.

### Required to migrate

1. **Make CI green.** Currently `ci.yml` fails on Prettier. Fix the format drift, add a pre-commit hook so it can't recur. (Phase 1 prerequisite.)
2. **Provision SSH deploy keys** on the runner — the relay droplet, mombadil, bombadil, and each fleet VM need to accept the runner's public key. (Or use an SSH-agent forwarding scheme via a bastion.)
3. **`deploy.yml`** workflow:
   - Triggers on `main` push (after CI green) or manual `workflow_dispatch`
   - Runs the orchestrator's preflight + build + deploy + rollout steps
   - Uses GitHub-hosted runner for build (Ubuntu 22.04, has bun + node + nvidia tooling)
   - Uses self-hosted runner inside the LAN for fleet rollout (must reach 192.168.x.x)
   - Posts release notes to a Slack/Discord webhook on success/fail (optional)
4. **Branch protection on `main`** requiring CI to pass before merge.
5. **Auto-version bump** runs identical to the orchestrator's `compute_next_version`.

### What stays manual even after migration

- **Out-of-band hotfixes** — emergencies where the operator needs to bypass tests. The orchestrator script remains the manual fallback.
- **Rollback** — runs from the operator's machine, not CI. (CI doesn't know which version is "good"; the operator does.)
- **End-user install rollout** — never automated; users are off-LAN, not credentialed for the fleet, and own their own update cadence.

---

## Appendix A — release checklist (printable)

```
[ ] git status clean, on main, up to date
[ ] frontend lint + typecheck + test
[ ] backend lint + typecheck + test
[ ] target version computed (or specified)
[ ] target version not already published
[ ] deploy-relay.sh ran clean
[ ] X-Spaiglass-Version header matches target
[ ] all 5 platform tarballs reachable, embed correct VERSION
[ ] sgcleanrelay restarted, /api/health 200
[ ] fleet-rollout-spaiglass.sh: all 10 OK
[ ] out-of-inventory VMs (SoSatisfying, etc) updated via install.sh
[ ] all 11 connectors heartbeating fresh (≤120s)
[ ] active TCP socket count on relay ≥ 12
[ ] frontend __SG_VERSION matches target
[ ] release announcement posted (if applicable)
```

## Appendix B — file inventory

| File | Role |
|---|---|
| `relay/release/deploy-relay.sh` | Build + upload + restart relay (already exists, ~250 LOC) |
| `relay/release/pack.sh` | Build slim Node tarball (already exists) |
| `backend/scripts/build-binary.sh` | Cross-compile 5 platform binaries (already exists, fixed 2026-05-01) |
| `~/scripts/fleet-rollout-spaiglass.sh` | Update fleet VMs from relay (already exists, hardcoded inventory) |
| `~/scripts/release-spaiglass.sh` | **NEW** — orchestrator for full release (this doc's primary deliverable) |
| `~/scripts/rollback-spaiglass.sh` | **NEW** — restore previous version end-to-end |
| `.github/workflows/ci.yml` | Format/lint/typecheck/test on push (exists, currently red) |
| `.github/workflows/deploy.yml` | **NEW (phase 2)** — auto-deploy on green main |
| `.github/workflows/host-binaries.yml` | Build per-platform binaries in CI (exists, status unclear) |
