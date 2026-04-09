# Storyboard: SpAIglass Framework

## Product Identity

**SpAIglass** — A browser-based interface for Claude Code that works locally, across a fleet, or from anywhere via a public relay.

| Component | Name | What It Is |
|---|---|---|
| VM application | SpAIglass | Browser UI for Claude Code, runs on each VM |
| Relay server | SGCleanRelay | Public routing layer at spaiglass.xyz |
| Domain | spaiglass.xyz | Hosted relay with agentic setup |

---

## What We Have

Three documents describe three layers:

| Document | Layer | What It Solves |
|---|---|---|
| SPEC-PHASE1-VM-WEBUI.md | VM-side application | "I want to use Claude Code from a browser instead of a terminal" |
| persistent-session-architecture.md | Transport upgrade | "I want the browser experience to match the native CLI — slash commands, interrupt, queued messages" |
| SPEC-PHASE2-RELAY-SERVER.md | Public access | "I want to reach my VM from any network, not just Tailscale" |

---

## The User Journey

### Today (SpAIglass as-built)

```
User with browser  ──Tailscale──>  VM running SpAIglass  ──>  Claude CLI
     (LAN/VPN)                     (port 3000)                (one-shot per message)
```

Works, but:
- Must be on Tailscale or same LAN
- Each message spawns a new CLI process (no slash commands, no interrupt, no persistence)
- No way to share access or manage VMs from a public URL

### Target (All Three Layers Combined)

```
User with browser  ──HTTPS──>  SGCleanRelay       ──WSS──>  VM Connector  ──>  Claude CLI
     (anywhere)                (spaiglass.xyz)              (private VM)       (persistent session)
                                    │
                                    ├── GitHub OAuth (who are you?)
                                    ├── Connector registry (which VMs are yours?)
                                    ├── Multi-user access (org members share fleet)
                                    └── WS proxy (route traffic to the right VM)
```

---

## Decided Architecture

### Multi-User Model

Each org can share a fleet of VMs. Every user:
- Logs in via GitHub OAuth (their own identity)
- Sees the shared fleet of VMs and roles
- Picks a role, gets their own session
- Multiple users can work on the same VM simultaneously (separate sessions)
- The VM's SessionManager handles concurrent sessions keyed by `(userId, roleFile)`

### Session Model (Telegram Pattern)

One active session per user per role. All devices share it.

- Session identified by `(userId, roleFile)`
- Second device connecting to the same session gets existing history + live messages
- Mobile, iPad, desktop browser all see the same conversation
- User explicitly restarts to get a fresh session
- No accidental multi-session spawning

**Session garbage collection** (tabled for later): timeout-based cleanup, health checks, explicit session list management. Build the single-session model first, handle edge cases when real usage reveals failure modes.

### Security Model for Hosted Relay

The relay is architecturally unable to access user data:
- Never stores API keys, file contents, or conversation data
- Routes encrypted WebSocket traffic between browser and VM
- Sees HTTP headers for routing, nothing else
- If the relay is compromised, the attacker gets routing config only — no secrets

**Verification layers:**
- Open source — full source published, anyone can audit or self-host
- SLSA attestation via GitHub Actions — signed builds with verifiable supply chain
- Public threat model documentation
- The security argument is architectural (relay CAN'T see your data), not trust-based (relay PROMISES not to see your data)

Reproducible builds are a stretch goal — high effort, low marginal return given the relay's limited access.

### WebSocket Everywhere

The Phase 2 spec's "WebSocket proxying not required" is overridden. The persistent session architecture requires WebSocket transport end-to-end:

```
Browser  ──WS──>  SGCleanRelay  ──WS──>  VM SessionManager  ──stdin/stdout──>  Claude CLI
```

The relay proxies full bidirectional WebSocket connections, not just HTTP request/response pairs. This enables:
- Persistent sessions with slash commands and interrupt
- Real-time streaming without HTTP chunking hacks
- Queue-while-thinking (messages sent during response)
- Session sharing across devices (same WS session, multiple consumers)

---

## How The Three Docs Merge

### Layer 1: VM Application (SpAIglass)

Most is already built. Remaining:

| Feature | Status | Notes |
|---|---|---|
| Auth middleware | Done | |
| Config endpoint | Done | |
| File browser + tree | Done | |
| File editor (Monaco) | Done | |
| Image upload | Done | |
| File delivery from Claude | Done | |
| Layout (3-panel) | Done | |
| Systemd service | Done | |
| Deploy script | Done | |
| Session persistence | Done | |
| Fleet portal | Done | |
| **Persistent sessions** | **Next** | SessionManager + WS endpoint |
| **Slash command dropdown** | **Next** | `/` trigger, init message data |
| **Multi-session support** | **Next** | Concurrent sessions per (userId, role) |
| **Relay connector mode** | **After relay** | WS outbound to SGCleanRelay |
| **File download endpoint** | **Not started** | Content-Disposition header |

### Layer 2: Persistent Sessions

Replaces one-shot HTTP with persistent WebSocket sessions.

| Component | What It Does |
|---|---|
| SessionManager | One `query()` per (userId, role), async message queue |
| WebSocket endpoint | Persistent connection, replaces fetch-per-message |
| Slash command dropdown | `/` shows CLI commands from init message |
| Interrupt | `query.interrupt()` — stops Claude, session stays alive |
| Queue-while-thinking | Messages queue, process in order after current turn |
| Session sharing | Multiple devices consume same session's output |

### Layer 3: SGCleanRelay (spaiglass.xyz)

Hosted at spaiglass.xyz. Pure routing, no secrets.

| Component | What It Does |
|---|---|
| GitHub OAuth | User identity for org members |
| Connector registry | Register VMs, get tokens |
| Channel manager | Track live WS connections from VMs |
| WS proxy | Route browser WS to correct VM |
| Dashboard | Fleet view with online/offline status |
| Agent API keys | Claude agents register VMs programmatically |
| Setup docs page | Machine-readable setup guide for agents |
| SLSA attestation | Verifiable builds via GitHub Actions |

---

## Build Order

```
Phase A: Persistent Sessions (Layer 2)
  ├── Backend: SessionManager + WebSocket endpoint
  ├── Frontend: WebSocket client replaces fetch
  ├── Slash command dropdown
  ├── Interrupt support
  └── Queue-while-thinking

Phase B: SGCleanRelay (Layer 3) + Deploy to spaiglass.xyz
  ├── GitHub OAuth + session management
  ├── SQLite: users, connectors, sessions
  ├── Connector WebSocket server + channel manager
  ├── WS proxy (bidirectional, not HTTP-only)
  ├── Dashboard frontend
  ├── Agent API keys + setup docs page
  ├── Cloudflare DNS for spaiglass.xyz
  └── Deploy and verify

Phase C: Relay Connector (Layer 1 addition)
  ├── backend/relay/connector.ts
  ├── WS outbound to SGCleanRelay
  ├── Bidirectional WS tunneling
  ├── Reconnect with exponential backoff
  └── Multi-session support on VM side

Phase D: Polish
  ├── Mobile testing (iPhone Safari)
  ├── Rate limiting on relay
  ├── Session GC and health monitoring
  ├── SLSA build attestation
  └── Public threat model documentation
```

---

## Deployment Modes

### Mode 1: Local (Solo Developer)

```
laptop browser → http://vm-ip:3000
```

Install SpAIglass on a VM, access via local network or Tailscale. No relay needed. Full features.

### Mode 2: Fleet (Team / Multi-VM)

```
laptop browser → http://portal-ip:9090 → pick a VM → http://vm-ip:3000
```

Fleet portal shows all VMs with roles. Direct access via Tailscale. Deploy script provisions new VMs.

### Mode 3: Public via SGCleanRelay

```
any browser → https://spaiglass.xyz → dashboard → pick a VM → proxied to VM
```

GitHub login. No VPN. Works from any device, any network. Claude agents auto-provision VMs via API.

### Mode 4: Agent-Driven Setup (Fully Automated)

```
Claude agent → POST spaiglass.xyz/api/connectors → provisions VM → installs SpAIglass → connects to relay
```

1. User creates API key from spaiglass.xyz dashboard
2. Gives it to their Claude agent
3. Agent reads setup docs at spaiglass.xyz/setup
4. Agent provisions VM, installs SpAIglass, registers with relay
5. VM appears in dashboard automatically — ready to use
