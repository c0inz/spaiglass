# SpAIglass

**Claude chat and markdown access from ANYWHERE.**

> Browser-based multi-VM interface for Claude Code. Open source. Fully auditable. Your code never leaves your machine.

SpAIglass lets you run Claude Code on remote VMs and access them through your browser — from any device, anywhere. Chat with Claude, browse your project files, edit markdown, and manage your AI agent fleet. The relay is a stateless routing proxy: it routes traffic but never stores, inspects, or logs your code, conversations, or files. All relay traffic is TLS-encrypted end to end.

| | |
|---|---|
| **Source code** | [github.com/c0inz/spaiglass](https://github.com/c0inz/spaiglass) |
| **Live relay** | [spaiglass.xyz](https://spaiglass.xyz) |
| **License** | [MIT](LICENSE) — free and open source |
| **Operator** | [ReadyStack.dev](https://readystack.dev) |

### Features

- **Chat with Claude Code** from any browser — laptop, phone, tablet
- **Survives disconnect** — close your laptop, switch wifi, lose signal: when you reconnect, the session replays missed output and continues live (30-min idle window)
- **Share VMs with collaborators** — invite teammates by GitHub login as `editor` (full chat access) or `viewer` (read-only), with an audit log of every membership change
- **Cross-platform host support** — Linux, macOS (Intel + Apple Silicon), and Windows 10/11 in the same fleet
- **One-line install per platform** — `curl install.sh | bash` on Linux/macOS, `iwr install.ps1 | iex` on Windows
- **Project file browser** — see and edit your files while you chat
- **Markdown editor** — Monaco-powered, syntax highlighted, Ctrl+S to save
- **Six themes** — light, dark, glass, plain, plus 70s amber/green CRT phosphor with a five-color picker
- **Role-based sessions** — define agent roles per project via `agents/*.md` files
- **Architecture viewer** — ASCII diagrams from `architecture.json`
- **Multi-VM fleet management** — one dashboard for all your machines, with a per-VM version-skew banner
- **Open source & fully auditable** — MIT licensed, relay is ~800 lines of TypeScript
- **Risk-avoidance architecture** — relay never stores code, files, or conversations
- **Full encryption** — all traffic is HTTPS/WSS (TLS 1.3)
- **Outbound-only** — VMs connect out, no inbound ports or firewall holes needed

### Supported Claude CLI platforms

Spaiglass uses the official **Anthropic Claude Code CLI** to spawn sessions on each host. It runs anywhere the Claude CLI does:

| Platform | Versions | Service | Installer |
|---|---|---|---|
| **Linux** | Ubuntu, Debian, Fedora, Arch — anything with `bash`, `tar`, `node>=20` | `systemd --user` with linger | `curl -fsSL https://spaiglass.xyz/install.sh \| bash -s -- ...` |
| **macOS** | 12+ on Intel or Apple Silicon | launchd LaunchAgent under `~/Library/LaunchAgents` | `curl -fsSL https://spaiglass.xyz/install.sh \| bash -s -- ...` |
| **Windows** | 10 (build 17063+) and 11 | Per-user Scheduled Task at logon (no admin) | `& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) ...` |

Install the Claude Code CLI first via [`claude.ai/install.sh`](https://claude.ai/install.sh) (Linux/macOS) or [`claude.ai/install.ps1`](https://claude.ai/install.ps1) (Windows), then run the spaiglass installer for your platform.

---

## Architecture

```
Browser (any device)
  |
  | HTTPS + WSS  (TLS 1.3 via Caddy + Let's Encrypt)
  v
SGCleanRelay (spaiglass.xyz)              <-- this repo: relay/
  |  - GitHub OAuth + session cookies
  |  - Connector registry (SQLite)
  |  - Agent key API
  |  - WebSocket tunnel routing
  |  - Serves the React frontend dist/    <-- so VMs only ship the backend
  |
  | WSS (persistent, dialed OUT from the host)
  v
Spaiglass host (Linux / macOS / Windows)  <-- this repo: backend/ + connector
  |  - Backend on 127.0.0.1:8080
  |  - Outbound connector dials wss://spaiglass.xyz/connector
  |  - File browser, editor, project discovery
  |  - Spawns the Anthropic Claude Code CLI
  v
Claude Code CLI (local)
  |
  v
Anthropic API (api.anthropic.com)
```

### How it works

1. **You sign in** to the relay with GitHub OAuth
2. **Register a VM** -- the relay gives you a connector token
3. **Your VM connects** to the relay using that token (outbound WebSocket, no inbound ports needed)
4. **You open a browser** -- the relay tunnels your session to the VM in real time
5. **The relay never sees your data** -- it forwards WebSocket frames without inspection or storage

### Components

| Directory | What it is |
|---|---|
| `relay/` | SGCleanRelay -- stateless routing proxy (Hono + SQLite) |
| `backend/` | SpAIglass VM backend (Claude Code SDK, session manager) |
| `frontend/` | SpAIglass web UI (React, chat interface) |
| `research/` | Design specs and architecture decisions |

---

## Trust & Security

SpAIglass is open source specifically so that you (and your LLM agents) can verify exactly what runs between your browser and your VMs.

### What the relay stores

- **GitHub profile:** username, display name, avatar URL, GitHub user ID
- **Session tokens:** random values, expire automatically, cleaned hourly
- **Connector records:** VM name, hashed auth token, last-seen timestamp
- **Agent API keys:** SHA-256 hashed only -- plaintext shown once at creation, never stored
- **Collaborator records:** for each shared VM, the GitHub user ID of each invited collaborator and their role (`editor` or `viewer`)
- **Collaboration audit log:** add/remove/role-change events with actor + target user IDs and timestamps (no message content)

### What the relay does NOT store

- No VM traffic content -- WebSocket frames are forwarded, not logged or inspected
- No conversation history -- that lives on your VM, never touches the relay
- No files or code -- the relay has no access to your VM filesystem
- No long-lived OAuth tokens -- GitHub tokens are used once during sign-in and discarded
- No analytics, tracking cookies, or third-party scripts

> **Viewer-mode caveat:** for connections by users with the `viewer` role, the relay parses *only* the `type` field of each browser→VM JSON frame to enforce read-only access (e.g. blocking `message` and `interrupt`). Frame *content* is never read or logged. Owner and editor traffic is forwarded fully opaquely.

### Data flow transparency

All browser-to-VM communication uses WebSocket tunneling. The relay:
1. Authenticates the browser session (cookie) and validates VM ownership
2. Looks up the target VM's live WebSocket connection
3. Forwards each frame bidirectionally without modification
4. Never buffers, stores, or inspects frame contents

The relay is **stateless for session data** -- if it restarts, VMs reconnect automatically. The only persistent state is the SQLite connector registry.

### Build & release verification

> **Status: Planned -- implementation in progress**

We are implementing the following verification mechanisms. This section will be updated with concrete instructions as each ships.

**Reproducible builds**
All release artifacts will be built in CI with pinned dependencies. Build logs will be public. Anyone can clone the repo and produce a byte-identical artifact.

**SHA-256 checksums**
Every release will publish a `checksums.txt` file containing SHA-256 hashes for all artifacts. Verify with:
```bash
# Example (placeholder -- actual hashes published per release)
sha256sum -c checksums.txt
```

**Signed commits**
All release commits will be GPG-signed. Verify with:
```bash
git verify-commit HEAD
```

**Supply chain attestation**
We plan to use GitHub's artifact attestation (Sigstore-backed) so that each release artifact is cryptographically tied to the CI workflow that built it. Verify with:
```bash
# Example (placeholder -- will use gh attestation verify)
gh attestation verify <artifact> --repo c0inz/spaiglass
```

**Deployed relay verification**
A mechanism to verify that the code running on spaiglass.xyz matches a specific commit:
```bash
# Planned: /api/health will include commit SHA
curl https://spaiglass.xyz/api/health
# {"status":"ok","version":"0.1.0","commit":"abc123..."}

# Compare against repo
git rev-parse HEAD
```

### Network security

- All traffic to spaiglass.xyz is HTTPS/WSS (TLS via Caddy + Let's Encrypt)
- VMs connect outbound only -- no inbound ports required on your infrastructure
- Connector tokens are 256-bit random, stored as SHA-256 hashes
- Agent API keys use `sg_` prefix with 256-bit entropy, stored hashed
- Rate limiting: 20 req/min on auth endpoints, 100 req/min on API endpoints
- Sessions expire automatically; cleanup runs hourly

### Audit the code yourself

The relay is ~800 lines of TypeScript across 8 files in `relay/src/`. Start here:

| File | What to audit |
|---|---|
| [`relay/src/server.ts`](relay/src/server.ts) | Route definitions, middleware stack |
| [`relay/src/tunnel.ts`](relay/src/tunnel.ts) | WebSocket forwarding -- verify no data inspection |
| [`relay/src/auth.ts`](relay/src/auth.ts) | OAuth flow -- verify token handling |
| [`relay/src/middleware.ts`](relay/src/middleware.ts) | Auth + rate limiting logic |
| [`relay/src/db.ts`](relay/src/db.ts) | Schema -- verify what's stored |

---

## Quick Start

### Browser enrollment (recommended)

1. Sign in at [spaiglass.xyz](https://spaiglass.xyz) with GitHub
2. Click **Register VM**, give it a name — the dashboard pops up a modal with two tabs:
   - **Linux / macOS:** `curl -fsSL https://spaiglass.xyz/install.sh | bash -s -- --token=… --id=… --name=…`
   - **Windows 10/11:** `& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) -Token … -Id … -Name …`
3. Paste the command on the host. The installer downloads a slim tarball (~130 KB), installs production node deps, writes a `.env`, and registers a service that runs at boot/logon.
4. Your VM appears on the dashboard at `https://spaiglass.xyz/vm/<github-login>.<vm-name>/`.

The installer is **idempotent** — re-run it to upgrade in place. It preserves your `.env` and restarts the service. Pass `--uninstall` (or `-Uninstall` on Windows) to remove.

### Fully agentic enrollment (zero human interaction)

For LLM agents and provisioning scripts, the relay's `/api/setup` endpoint returns the same instructions as JSON. The full machine-readable flow:

```bash
# Step 1: Exchange a GitHub PAT for a reusable spaiglass agent key
curl -X POST https://spaiglass.xyz/api/auth/token-exchange \
  -H "Content-Type: application/json" \
  -d '{"github_pat": "ghp_YOUR_TOKEN", "key_name": "provisioner"}'
# Returns: { "agent_key": "sg_...", "user": { "login": "..." } }

# Step 2: Register a VM (returns a one-time install token)
curl -X POST https://spaiglass.xyz/api/connectors \
  -H "Authorization: Bearer sg_YOUR_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "dev-vm-01"}'
# Returns: { "id": "abc-123", "token": "...", "name": "dev-vm-01" }

# Step 3a: Install on the host — Linux or macOS
curl -fsSL https://spaiglass.xyz/install.sh | bash -s -- \
    --token=YOUR_TOKEN --id=abc-123 --name=dev-vm-01

# Step 3b: Install on the host — Windows 10/11 (PowerShell, no admin)
& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) `
    -Token YOUR_TOKEN -Id abc-123 -Name dev-vm-01

# Step 4: Done. The host is live at:
#   https://spaiglass.xyz/vm/<github-login>.dev-vm-01/
```

### Prerequisites on the host

- **Node.js >= 20** and **npm**
- **Claude Code CLI** installed and authenticated:
  - Linux/macOS: `curl -fsSL https://claude.ai/install.sh | bash` then `claude` (one-time auth)
  - Windows: `irm https://claude.ai/install.ps1 | iex` then `claude` (one-time auth)
- Linux only: `tar` and `bash`
- Windows only: PowerShell 5.1+ and `tar.exe` (ships with Windows 10 1803+)

### Sharing a VM with a collaborator

Each VM has one owner (the GitHub user who registered it) and zero or more collaborators. Collaborators get one of two roles:

- **Editor** — full chat, file browsing, editing, and interruption. Can do everything the owner can except manage other collaborators or delete the VM.
- **Viewer** — read-only. Can navigate the dashboard, browse files, and watch a live chat session, but cannot send messages, interrupt the agent, or edit files. The relay enforces this; viewers can only attach to a session the owner has already started.

To invite someone:

1. Open the dashboard at [spaiglass.xyz](https://spaiglass.xyz)
2. Click **Manage** on the VM you want to share
3. Enter the collaborator's GitHub login and pick a role
4. They'll see the VM under **Shared with me** the next time they sign in

The invitee must have signed in to spaiglass at least once so the relay has a user record to invite. Collaborator add/remove/role-change events are recorded in the per-VM audit log, visible to the owner via `GET /api/connectors/:id/audit`.

### Adding more VMs to the same account

The agent key is reusable. Repeat step 2 + step 3 with the same key — each host gets its own connector ID and token under the same account. Mix Linux, macOS, and Windows freely.

```bash
# Same agent key, new VM
curl -X POST https://spaiglass.xyz/api/connectors \
  -H "Authorization: Bearer sg_YOUR_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "staging-vm-02"}'
```

### Self-host the relay

```bash
git clone https://github.com/c0inz/spaiglass.git
cd spaiglass/relay
cp .env.example .env
# Edit .env with your GitHub OAuth app credentials
npm install
npx tsx src/server.ts
```

---

## Documentation

| File | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical decisions and system design |
| [REQUIREMENTS.md](REQUIREMENTS.md) | User requirements |
| [FEATURES.md](FEATURES.md) | Feature reference |
| [TASKS.md](TASKS.md) | Build status and progress |
| [research/](research/) | Design specs and investigation notes |

---

## Upstream

SpAIglass extends [claude-code-webui](https://github.com/sugyan/claude-code-webui) by sugyan. The VM backend and web frontend are forked from that project. SGCleanRelay is original work.

---

## License

MIT License -- see [LICENSE](LICENSE) for full text.

Copyright (c) 2025-2026 ReadyStack.dev
Original upstream copyright (c) 2025 Claude Code Web UI

SpAIglass is free and open source software. You can use, modify, and distribute it under the terms of the MIT License.
