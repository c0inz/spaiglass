# SpAIglass Unified Specification

Version 1.0 — April 2026

---

## 1. System Overview

SpAIglass is a browser-based interface for Claude Code. It has two deployable components:

| Component | Repo | Runs Where | Purpose |
|---|---|---|---|
| **SpAIglass** | `c0inz/spyglass` | Each VM | Browser UI + Claude CLI session management |
| **SGCleanRelay** | `c0inz/sgcleanrelay` | Public VPS (spaiglass.xyz) | Routing layer for public access |

### Architecture

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────────┐       ┌───────────┐
│   Browser   │──WS──>│   SGCleanRelay   │──WS──>│   SpAIglass VM   │──────>│ Claude CLI│
│ (any device)│       │ (spaiglass.xyz)  │       │ (SessionManager) │       │ (stdin/out)│
└─────────────┘       └──────────────────┘       └──────────────────┘       └───────────┘
                              │
                       GitHub OAuth
                       Connector Registry
                       Agent API Keys
```

Users can also connect directly to SpAIglass VMs (local/Tailscale) without the relay.

---

## 2. SpAIglass VM Application

### 2.1 Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Backend | Hono (HTTP + WebSocket) |
| Frontend | React 19 + Vite + TailwindCSS |
| Editor | Monaco Editor |
| Claude SDK | `@anthropic-ai/claude-code` |

### 2.2 Environment Variables

```bash
# Required
VM_ROLE=Designer              # Role shown in header

# Optional
AUTH_PASSWORD=                 # Password for login (skip if unset)
PORT=8080                     # Backend port
HOST=0.0.0.0                  # Bind address
DEBUG=false                   # Debug logging

# Relay mode (when connecting to SGCleanRelay)
RELAY_URL=                    # wss://spaiglass.xyz/connector
RELAY_TOKEN=                  # Token from SGCleanRelay registration
```

### 2.3 Persistent Session Transport

**This is the primary transport. The one-shot HTTP model is legacy.**

The backend maintains persistent Claude CLI sessions via the SDK's `AsyncIterable<SDKUserMessage>` interface:

```
Browser ──WebSocket──> SpAIglass Backend ──stdin/stdout──> Claude CLI Process
                       (SessionManager)                    (--input-format stream-json)
```

#### 2.3.1 SessionManager

One running `query()` per active session. Sessions keyed by `(userId, roleFile)`.

```typescript
interface Session {
  id: string;                          // UUID
  userId: string;                      // GitHub user ID or local user
  roleFile: string;                    // e.g. "developer.md"
  query: Query;                        // SDK Query object
  messageQueue: AsyncQueue<SDKUserMessage>;  // Backed async iterable
  consumers: Set<WebSocket>;           // All connected devices
  createdAt: number;
  lastActivity: number;
}
```

**Lifecycle:**
1. Client connects via WebSocket, requests session for a role
2. SessionManager checks for existing session with same `(userId, roleFile)`
3. If exists and alive: attach as new consumer (Telegram model — same conversation)
4. If not: create new session, spawn `query()` with async iterable, start consuming SDK messages
5. SDK messages broadcast to all consumers
6. Any consumer can send user messages (pushed to queue, yielded to CLI)
7. Session ends when explicitly restarted by user, or after inactivity timeout

**Telegram model:** One session per (userId, role). Mobile, iPad, desktop all see the same conversation. No accidental multi-session spawning.

#### 2.3.2 WebSocket Endpoint

```
WS /api/ws
```

**Client → Server messages:**

```typescript
// Send a user message
{ type: "message", content: string, attachments?: string[] }

// Send a slash command
{ type: "message", content: "/compact" }

// Interrupt current response
{ type: "interrupt" }

// Change permission mode
{ type: "set_permission_mode", mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" }

// Start/resume session
{ type: "session_start", roleFile: string, sessionId?: string }

// Restart session (fresh)
{ type: "session_restart", roleFile: string }
```

**Server → Client messages:**

```typescript
// SDK messages (same format as existing NDJSON)
{ type: "sdk_message", data: SDKMessage }

// File delivery notification
{ type: "file_delivery", data: FileDelivery }

// Session info
{ type: "session_info", sessionId: string, slashCommands: string[] }

// Error
{ type: "error", message: string }

// Session ended
{ type: "session_ended", reason: string }
```

#### 2.3.3 Slash Commands

The init message from Claude CLI includes `slash_commands: string[]`. On session start, the server sends these to the client in the `session_info` message.

Frontend shows a filterable dropdown when the user types `/` (same UI pattern as the `@` file mention). Selecting a command inserts it as a regular message, which the CLI interprets.

#### 2.3.4 Interrupt

When the user clicks Stop:
1. Client sends `{ type: "interrupt" }` via WebSocket
2. Server calls `query.interrupt()` on the session's Query object
3. CLI stops processing, sends remaining buffered messages
4. Session stays alive, ready for next message

#### 2.3.5 File Attachments via WebSocket

Text files are read server-side and inlined into the message text. Images are read and included as base64 content blocks in the `SDKUserMessage`. Upload still happens via `POST /api/upload`, then the path is referenced in the WebSocket message's `attachments` array.

#### 2.3.6 Multi-Session Support

The SessionManager handles multiple concurrent sessions on one VM:
- Different users can have separate sessions on the same role
- Same user can have sessions on different roles simultaneously
- Session isolation: each session has its own Claude CLI process

Resource limits: configurable max concurrent sessions per VM (default: 10).

### 2.4 HTTP API (Retained)

These endpoints remain for file operations, upload, health, and fleet portal:

```
GET  /api/health                    Health check (no auth)
GET  /api/config                    VM role and metadata
POST /api/upload                    File upload (multipart)
GET  /api/files/tree                Directory listing
GET  /api/files/read                File contents
POST /api/files/write               Write file
GET  /api/files/download            Download file (Content-Disposition)
GET  /api/files/list                Recursive file list
GET  /api/files/snapshot            File snapshot
GET  /api/projects                  Project listing
GET  /api/projects/contexts         Available roles
GET  /api/discover                  Discovery for fleet portal
POST /api/session/stale             Stale context check
POST /api/session/save              Save last session
GET  /api/session/last              Get last session
```

The `POST /api/chat` endpoint is deprecated — WebSocket is the primary chat transport.

### 2.5 Frontend

#### 2.5.1 Layout

```
┌──────────────────────────────────────────────────────┐
│  SpAIglass    [project name]  / [role]    [buttons]  │
├───────────┬────────────────────────┬─────────────────┤
│           │                        │                 │
│  File     │   Editor / Arch        │     Chat        │
│  Sidebar  │   (Monaco / ASCII)     │  (WebSocket)    │
│  (224px)  │   (flex)               │   (450px/flex)  │
│           │                        │                 │
├───────────┴────────────────────────┴─────────────────┤
│  [mode] (Ctrl+Shift+M)    [thinking]    [bypass on]  │
└──────────────────────────────────────────────────────┘
```

#### 2.5.2 Chat Input Features

- **@-mention dropdown** — `@` trigger, filterable file list, keyboard nav
- **Slash command dropdown** — `/` trigger, filterable command list from CLI
- **File attach** — paperclip button, any file type, thumbnail/icon preview
- **Permission mode** — click or Ctrl+Shift+M to cycle
- **Thinking level** — click to cycle: off / brief (5k) / extended (32k)
- **Bypass permissions** — always on indicator
- **Send while thinking** — input never disabled, messages queue

#### 2.5.3 Message Types

| Type | Rendering |
|---|---|
| Chat (user) | Blue bubble, right-aligned |
| Chat (assistant) | Gray bubble, left-aligned |
| System (init) | Collapsible blue box |
| System (result) | Collapsible blue box with cost/tokens |
| Tool use | Green label with tool name |
| Tool result | Green collapsible with preview |
| Thinking | Purple collapsible, expanded by default |
| Plan | Blue box with approval buttons |
| Todo | Amber list with status icons |
| File delivery | Violet card with Open/Download buttons |

### 2.6 Relay Connector Mode

When `RELAY_URL` and `RELAY_TOKEN` are set:

1. SpAIglass connects outbound to SGCleanRelay via WebSocket
2. Authenticates with token
3. All browser connections arrive through the relay tunnel
4. HTTP endpoints are proxied through the relay
5. WebSocket sessions are tunneled through the relay's WS proxy

Reconnect with exponential backoff: 1s, 2s, 4s, 8s, max 60s.

### 2.7 Deployment

**Systemd services:** Three units (backend, frontend, portal) + grouping target.

**Deploy script:** `deploy-webui.sh --host <ip> --role <role> [--password <pass>]` or `--manifest <file>` for bulk.

---

## 3. SGCleanRelay

### 3.1 Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Hono |
| WebSocket | ws library |
| Auth | GitHub OAuth 2.0 |
| Database | SQLite via better-sqlite3 |
| Frontend | React 19 + Vite + TailwindCSS |
| Deployment | spaiglass.xyz via Cloudflare |

### 3.2 Environment Variables

```bash
# Required
PORT=3000
HOST=0.0.0.0
BASE_URL=https://spaiglass.xyz
SESSION_SECRET=<random>
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Optional
DB_PATH=./data/relay.db
MAX_CONNECTORS_PER_USER=10
CONNECTOR_PING_INTERVAL=30000
CONNECTOR_TIMEOUT=90000
```

### 3.3 Database Schema

Three tables. No conversation history. No file contents. No API keys. Ever.

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  github_id   TEXT UNIQUE NOT NULL,
  username    TEXT NOT NULL,
  email       TEXT,
  avatar_url  TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE connectors (
  id          TEXT PRIMARY KEY,      -- UUID, used as RELAY_TOKEN
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      TEXT,                  -- NULL = personal, otherwise shared org
  name        TEXT NOT NULL,
  vm_role     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_connected INTEGER,
  UNIQUE(user_id, name)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT,
  ip_address  TEXT
);

CREATE TABLE agent_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL,         -- SHA-256 of the key
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
```

### 3.4 Authentication

#### GitHub OAuth Flow

```
GET  /auth/github             → Redirect to GitHub authorize
GET  /auth/github/callback    → Exchange code, upsert user, set cookie
POST /auth/logout             → Clear session
GET  /api/auth/me             → Current user info
```

Session cookie: `sgcr_session`, httpOnly, secure, sameSite strict, 30 day expiry.

#### Agent API Keys

For programmatic access by Claude agents:

```
POST   /api/agent-keys        → Create key (returns plaintext once)
GET    /api/agent-keys        → List keys (name + created, no key value)
DELETE /api/agent-keys/:id    → Revoke key
```

Keys passed as `Authorization: Bearer <key>`. Agents can:
- Register connectors
- Download config files
- Check connector status

### 3.5 Connector Management

```
POST   /api/connectors             → Register VM, returns token
GET    /api/connectors             → List with online/offline status
DELETE /api/connectors/:id         → Delete (disconnects active session)
GET    /api/connectors/:id/config  → Download .env config file
```

### 3.6 WebSocket Relay

#### Connector Connection (VM → Relay)

```
WSS spaiglass.xyz/connector
```

1. VM connects, sends `{ type: "auth", token: "<RELAY_TOKEN>" }`
2. Relay validates → `{ type: "auth_ok", connectorId: "..." }`
3. Channel manager registers live connection
4. Ping/pong every 30s, timeout after 90s
5. On disconnect: mark offline, fail pending requests with 503
6. VM reconnects with exponential backoff

#### Browser Connection (Browser → Relay → VM)

```
WSS spaiglass.xyz/vm/:connectorId/ws
```

1. Browser connects with session cookie
2. Relay validates session, validates connectorId belongs to user's org
3. Relay opens a tunneled WebSocket to the VM's connector channel
4. All messages forwarded bidirectionally: browser ↔ relay ↔ VM
5. VM's SessionManager receives WebSocket messages as if browser connected directly

#### HTTP Proxy (for file operations)

```
/vm/:connectorId/api/*
```

1. Validate session + ownership
2. Check connector online
3. Forward HTTP request through connector WebSocket tunnel
4. Return response to browser

### 3.7 Dashboard Frontend

**`/` — Dashboard (auth required)**

Fleet view showing all connectors:
- Green dot = online, red dot = offline
- Click to open SpAIglass UI (proxied through relay)
- Settings: token rotation, delete

**`/setup` — Setup Documentation**

Machine-readable page for Claude agents. Contains:
- Prerequisites
- Step-by-step installation commands
- API reference for automated setup
- Config file reference

**`/vm/:connectorId/` — Proxied SpAIglass**

Full SpAIglass UI, proxied through the relay. Browser thinks it's talking to spaiglass.xyz. All traffic tunneled to VM.

### 3.8 Security Model

**Architectural guarantee:** The relay cannot access user data.

| Concern | Mitigation |
|---|---|
| Relay compromise | No API keys, files, or conversations stored. Attacker gets routing config only. |
| User A accessing User B's VM | Connector ownership validated on every request |
| Stolen connector token | Only routes traffic to that VM; delete to revoke |
| Path traversal | VM-side validates all paths (SpAIglass responsibility) |
| DDoS | Rate limiting: 100 req/min per session, 10 concurrent streams |
| Session hijacking | httpOnly, secure, SameSite strict cookies |
| Token brute force | UUIDs (122 bits entropy), rate limit 5/min per IP |

**Verification:**
- Open source with public audit
- SLSA build attestation via GitHub Actions
- Published threat model

### 3.9 Rate Limiting

| Route | Limit |
|---|---|
| Unauthenticated | 20 req/min per IP |
| Authenticated API | 100 req/min per user |
| Proxy routes | 200 req/min per user |
| OAuth callback | 10 req/min per IP |
| Connector auth | 5 attempts/min per IP |

### 3.10 Deployment

Single Node.js process behind Caddy (auto HTTPS):

```
spaiglass.xyz {
  reverse_proxy localhost:3000
}
```

Minimum spec: 1 vCPU, 512MB RAM, 10GB disk.
Capacity: ~500 simultaneous connectors, ~100 concurrent browser sessions.

---

## 4. Multi-User and Org Model

### Access Control

- Each user has GitHub identity
- Connectors can be personal or shared (org_id)
- Org members share access to all org connectors
- Each user gets independent sessions (Telegram model)

### Session Isolation

- Session = (userId, roleFile) on a specific VM
- Each session has its own Claude CLI process
- Multiple users on the same VM see independent conversations
- Same user on multiple devices sees the same conversation

### Session Lifecycle

1. User selects a VM and role
2. SessionManager checks for existing (userId, role) session
3. If exists: attach new device as consumer
4. If not: spawn new CLI process, create session
5. All messages broadcast to all device consumers
6. Session persists across reconnects (auto-resume)
7. Explicit restart creates new session (old one cleaned up)
8. Inactivity timeout: session garbage collected after configurable period

---

## 5. What The Relay Does NOT Do

Explicit for all builders:

- Does NOT store conversation history (lives on VM)
- Does NOT store project files (live on VM)
- Does NOT store or handle Anthropic API keys (live on VM)
- Does NOT run Claude (runs on VM)
- Does NOT inspect proxied request/response bodies beyond routing headers
- Does NOT modify proxied content
