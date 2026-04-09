# SpAIglass

> Browser-based multi-VM interface for Claude Code. Manage your AI agent fleet from any device.

SpAIglass lets you run Claude Code on remote VMs and access them through your browser. The relay server handles authentication, routing, and WebSocket tunneling so you never need SSH or a terminal.

**Source code:** [github.com/c0inz/spaiglass](https://github.com/c0inz/spaiglass)
**Live relay:** [spaiglass.xyz](https://spaiglass.xyz)
**License:** [MIT](LICENSE)
**Operator:** [ReadyStack.dev](https://readystack.dev)

---

## Architecture

```
Browser (any device)
  |
  | HTTPS + WSS
  v
SGCleanRelay (spaiglass.xyz)        <-- this repo: relay/
  |  - GitHub OAuth
  |  - Connector registry (SQLite)
  |  - Agent key API
  |  - WebSocket tunnel routing
  |
  | WSS (persistent)
  v
SpAIglass VM (your infrastructure)   <-- this repo: backend/ + frontend/
  |  - Claude Code SDK
  |  - Persistent sessions
  |  - File management
  v
Claude API (Anthropic)
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

### What the relay does NOT store

- No VM traffic content -- WebSocket frames are forwarded, not logged or inspected
- No conversation history -- that lives on your VM, never touches the relay
- No files or code -- the relay has no access to your VM filesystem
- No long-lived OAuth tokens -- GitHub tokens are used once during sign-in and discarded
- No analytics, tracking cookies, or third-party scripts

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

The relay is ~500 lines of TypeScript across 8 files in `relay/src/`. Start here:

| File | What to audit |
|---|---|
| [`relay/src/server.ts`](relay/src/server.ts) | Route definitions, middleware stack |
| [`relay/src/tunnel.ts`](relay/src/tunnel.ts) | WebSocket forwarding -- verify no data inspection |
| [`relay/src/auth.ts`](relay/src/auth.ts) | OAuth flow -- verify token handling |
| [`relay/src/middleware.ts`](relay/src/middleware.ts) | Auth + rate limiting logic |
| [`relay/src/db.ts`](relay/src/db.ts) | Schema -- verify what's stored |

---

## Quick Start

### Use the hosted relay (spaiglass.xyz)

1. Sign in at [spaiglass.xyz](https://spaiglass.xyz) with GitHub
2. Register a VM and download the connector config
3. On your VM, set the env vars from the config and start the SpAIglass backend
4. Open your VM in the browser from the fleet dashboard

### Agentic enrollment (no browser needed)

```bash
# Create an agent key (one-time, from the dashboard)
# Then use it to register VMs programmatically:

curl -X POST https://spaiglass.xyz/api/connectors \
  -H "Authorization: Bearer sg_<your-agent-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-vm"}'

# Download the config
curl https://spaiglass.xyz/api/connectors/<id>/config \
  -H "Authorization: Bearer sg_<your-agent-key>" \
  -o connector.env
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
