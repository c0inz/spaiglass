# Architecture

## Overview

**SpAIglass** — fork of `sugyan/claude-code-webui` with added features. The application is split into a stateless internet-facing relay (`SGCleanRelay`) and a per-host backend that runs on each managed machine. The relay also serves the React frontend so that hosts only need to ship the backend.

```
User Browser (any device, any network)
      │
      │  HTTPS / WSS (TLS 1.3 via Caddy + Let's Encrypt)
      ▼
SGCleanRelay (spaiglass.xyz)
      │
      ├── GitHub OAuth + session cookies
      ├── Connector registry (SQLite)
      ├── Agent key API (sg_...)
      ├── WebSocket tunnel routing
      └── Serves the React frontend dist/
      │
      │  WSS (persistent, dialed OUT from each host)
      ▼
SpAIglass host backend (Linux / macOS / Windows)
      │
      ├── 127.0.0.1:8080 backend (Hono + Node.js >= 20)
      ├── Outbound connector → wss://spaiglass.xyz/connector
      ├── /api/chat     → spawns Anthropic Claude Code CLI
      ├── /api/files    → file browser, editor, project discovery
      ├── /api/upload   → image upload handler
      └── /api/projects → project directory management
      │
      ▼
Anthropic Claude Code CLI (installed on the host)
      │
      └── Runs inside the selected project directory
```

### Supported host platforms

| Platform | Versions | Service mechanism | Installer |
|---|---|---|---|
| **Linux** | Any distro with bash, tar, node >= 20 (Ubuntu, Debian, Fedora, Arch...) | `systemd --user` with linger enabled so the unit survives logout | `curl -fsSL https://spaiglass.xyz/install.sh \| bash -s -- ...` |
| **macOS** | macOS 12+ on Intel or Apple Silicon | `launchd` LaunchAgent in `~/Library/LaunchAgents` | `curl -fsSL https://spaiglass.xyz/install.sh \| bash -s -- ...` |
| **Windows** | Windows 10 build 17063+ and Windows 11 | Per-user Scheduled Task that runs at logon (no admin) | `& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) ...` |

The Claude Code CLI (from `claude.ai/install.sh` or `claude.ai/install.ps1`) must be installed and authenticated on the host before running the spaiglass installer. The spaiglass installers are idempotent — re-running upgrades in place and preserves the host's `.env`.

## Base Repository

**Upstream:** https://github.com/sugyan/claude-code-webui
**Fork:** https://github.com/c0inz/spyglass
**License:** MIT

**What the base provides (do not rewrite):**
- Claude CLI process spawning and management
- NDJSON streaming from Claude to browser
- Project directory selection
- Chat history storage and retrieval (per project, per session)
- Session resumption
- Dark/light theme
- Mobile responsive layout
- Abort/cancel running response

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend framework | React 19 | Already in base |
| Build tool | Vite + SWC | Already in base |
| Styling | TailwindCSS | Already in base |
| Backend framework | Hono | Already in base |
| Runtime | Node.js 20+ | Already in base |
| Markdown editor | Monaco Editor | Add - same editor as VS Code |
| Markdown preview | react-markdown | Add |
| File tree UI | react-arborist | Add - handles expand/collapse, lazy load |
| Auth | Custom middleware | Add - single password, session cookie |

## Features To Add To Base

### 1. Authentication Middleware
- Hono middleware that checks session cookie
- If no valid session: serve login page
- Login form posts password, compared to `AUTH_PASSWORD` env var
- On success: set signed session cookie, redirect to app
- All `/api/*` routes protected

### 2. VM Role Display
- New env var: `VM_ROLE` (e.g. "Designer", "Security Auditor", "Backend Developer")
- Backend exposes `GET /api/config` returning `{ role, vmName }`
- Frontend header displays role name
- Browser tab title set to role name

### 3. File Browser Sidebar
- New backend routes:
  - `GET /api/files/tree?path=<dir>` → returns directory listing (one level)
  - `GET /api/files/read?path=<file>` → returns file contents
  - `POST /api/files/write` → body: `{ path, content }` → writes file
- Frontend sidebar component using react-arborist
- Lazy loads directory contents on expand
- Click `.md` file → opens in editor panel
- Click other files → opens read-only preview
- Refresh button + auto-refresh after Claude tool calls that write files
- Security: all paths validated to be within the current project directory

### 4. Markdown Editor Panel
- Split view: raw Markdown on left, rendered preview on right
- Monaco Editor instance configured for Markdown
- Save button calls `POST /api/files/write`
- Dirty state indicator (unsaved changes warning)
- Keyboard shortcut: Ctrl+S / Cmd+S to save
- Opens in a panel alongside chat, not replacing it

### 5. Image Upload
- File input button in chat message bar (paperclip icon)
- Accepts: jpg, png, gif, webp
- `POST /api/upload` saves file to temp directory, returns file path
- File path passed into Claude query alongside message text
- Image displayed as thumbnail in the outgoing chat message

### 6. File Delivery From Claude
- Monitor Claude's tool call stream for file write events
- When Claude writes a `.md` or image file, inject a message into the chat:
  `[Claude created: filename.md] [Open in Editor] [Download]`
- `.md` files: render preview inline, button to open in editor
- Image files: display inline in chat
- Refresh file tree when any file write is detected

## Session Persistence

Each VM stores its last session state in a JSON file on disk:

```
~/.claude-webui/last-session.json
{
  "projectPath": "/home/readystack/projects/myapp",
  "contextFile": "agents/feature-build.md",
  "sessionId": "abc123"
}
```

- Written on every session start and context selection
- Read on page load — if file exists and session is valid, auto-resume
- If the referenced project or context file no longer exists, fall back
  to the project/context picker
- "New Session" button clears this and shows the picker

## Fleet Management (relay dashboard)

Fleet management is part of the relay itself — there is no separate portal. After signing in to `spaiglass.xyz` with GitHub, the dashboard lists every connector the user owns, regardless of platform, and provides:

- **Add VM modal** — generates a one-time install token and presents two tabs: Linux/macOS (`curl install.sh | bash`) and Windows (`iwr install.ps1 | iex`). Clipboard-ready commands include the token, connector ID, and host name.
- **Live status** — connector last-seen timestamps, online/offline indicators driven by the relay's WebSocket registry.
- **Per-VM links** — each connector renders a clickable URL of the form `https://spaiglass.xyz/vm/<github-login>.<vm-name>/` that tunnels the browser to that host.
- **Version-skew banner** — the relay-served frontend polls `/api/release` and surfaces a per-VM warning when a backend reports an older release than the relay.
- **Connector lifecycle** — rename, regenerate token, delete. Connector tokens are stored only as SHA-256 hashes.

### Discovery endpoint (on each host)

- `GET /api/discover?projectsDir=<path>` → scans for projects with `agents/*.md` files and returns the same structure used by the relay dashboard:
  ```json
  {
    "projects": [
      {
        "name": "DevOpsMachine",
        "path": "/home/johntdavenport/projects/DevOpsMachine",
        "roles": [
          { "name": "devops", "filename": "devops.md", "path": "agents/devops.md" }
        ]
      }
    ],
    "unassigned": [
      { "name": "spaiglass", "path": "/home/johntdavenport/projects/spaiglass" }
    ]
  }
  ```
- `projects` = directories with `agents/*.md` files (have roles)
- `unassigned` = directories without `agents/` (no roles yet)
- `GET /api/health` → `{ "status": "ok", "role": "<VM_ROLE>", "version": "<release>" }`

## Deployment

### Browser enrollment (recommended)

1. Sign in to `spaiglass.xyz` with GitHub.
2. Click **Register VM**, give it a name. The dashboard pops up a modal with two platform tabs.
3. Copy the appropriate one-line installer and paste it on the host.
4. The host appears in the dashboard at `https://spaiglass.xyz/vm/<github-login>.<vm-name>/`.

### Agentic / scripted enrollment

For LLM agents and provisioning scripts, the relay's `/api/setup` endpoint returns the same instructions as JSON, and `/api/auth/token-exchange` lets a GitHub PAT mint a reusable `sg_...` agent key. With that key the script:

```bash
# 1. Register the VM (returns id + one-time token)
curl -X POST https://spaiglass.xyz/api/connectors \
  -H "Authorization: Bearer sg_..." \
  -H "Content-Type: application/json" \
  -d '{"name":"dev-vm-01"}'

# 2a. Linux / macOS host
curl -fsSL https://spaiglass.xyz/install.sh | bash -s -- \
    --token=TOKEN --id=ID --name=dev-vm-01

# 2b. Windows host (PowerShell, no admin)
& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) `
    -Token TOKEN -Id ID -Name dev-vm-01
```

### What each installer does

| Step | Linux (`install.sh`) | macOS (`install.sh`) | Windows (`install.ps1`) |
|---|---|---|---|
| Download | Slim ~130 KB tarball from `spaiglass.xyz/dist/spaiglass-host.tar.gz` | Same | Same (tar.exe ships with Windows 10 1803+) |
| Install | Extracts under `~/.local/share/spaiglass`, runs `npm install --omit=dev` | Same | Extracts under `%LOCALAPPDATA%\spaiglass`, runs `npm install --omit=dev` |
| Config | Writes `~/.config/spaiglass/.env` with token + connector id | Same | Writes `%LOCALAPPDATA%\spaiglass\.env` |
| Service | `systemd --user` unit + `loginctl enable-linger` so it survives logout | `launchd` LaunchAgent in `~/Library/LaunchAgents`, loaded with `launchctl bootstrap gui/$(id -u)` | Per-user Scheduled Task that runs at logon, no admin required |
| Idempotency | Re-running upgrades in place, preserves `.env`, restarts the unit | Same | Same |
| Uninstall | `--uninstall` flag tears down service and removes the install dir | Same | `-Uninstall` flag |

### Per-host configuration

The backend reads its environment from the platform-appropriate `.env` file:

```
SPAIGLASS_RELAY_URL=wss://spaiglass.xyz
SPAIGLASS_CONNECTOR_ID=<uuid>
SPAIGLASS_CONNECTOR_TOKEN=<one-time token, used to authenticate the WSS dial>
VM_ROLE=Designer            # optional label shown in the header
PORT=8080                   # backend bound to 127.0.0.1:8080 only
CLAUDE_WORKING_DIR=...      # defaults to the user's home dir
```

The backend never opens an inbound port — all traffic reaches it via the outbound WebSocket dialed by the connector.

## Directory Structure (fork)

```
spyglass/                    ← forked repo
├── backend/
│   ├── handlers/
│   │   ├── chat.ts          ← existing, do not rewrite
│   │   ├── files.ts         ← NEW: file tree, read, write, recursive list
│   │   ├── contexts.ts      ← NEW: scan agents/ dir for context files
│   │   └── upload.ts        ← NEW: image upload handler
│   ├── middleware/
│   │   └── auth.ts          ← NEW: password auth middleware
│   └── index.ts             ← add new routes here
├── frontend/
│   ├── components/
│   │   ├── FileSidebar.tsx  ← NEW: file tree component + context highlighting
│   │   ├── FileMention.tsx  ← NEW: @-mention dropdown in chat input
│   │   ├── NewSessionDialog.tsx ← NEW: project + context picker
│   │   ├── FileEditor.tsx   ← NEW: Monaco editor panel (.md/.json/.txt)
│   │   ├── ArchitectureViewer.tsx ← NEW: ASCII-art architecture diagram
│   │   ├── StaleContextBanner.tsx ← NEW: stale file warning banner
│   │   ├── ImageUpload.tsx  ← NEW: upload button + preview
│   │   └── RoleHeader.tsx   ← NEW: VM role display
│   └── ...existing files
├── CLAUDE.md                ← instructions for Claude working on this repo
└── .env.example             ← document all env vars
```

### 7. File Mentions in Chat (`frontend/components/FileMention.tsx`)

- `@` keypress in chat input opens a dropdown overlay
- Backend route: `GET /api/files/list?path=<dir>&recursive=true` → returns
  flat list of all files in the project (cached, refreshed on file writes)
- Frontend maintains a list of files currently in session context (from
  context selector + any files Claude loads via tool calls)
- Dropdown rendering:
  1. Context files pinned to top, accent-colored
  2. Remaining files below, sorted alphabetically
  3. List filters as user types after `@`
- Selecting a file inserts its relative path into the chat input at cursor
  position
- Accent color for context files is shared between file tree sidebar and
  this dropdown (single CSS variable / Tailwind class)
- Mobile: dropdown triggered by `@` keypress on virtual keyboard, no hover
  interactions

### 8. Context File Highlighting in File Tree

- The file tree sidebar tracks which files are in the current session context
- Context is determined by: the context file selected at session start +
  any files Claude subsequently loads via tool calls during the session
- Context files render with an accent-colored filename (e.g. Tailwind
  `text-blue-400` in dark mode, `text-blue-600` in light mode)
- Non-context files render in the default text color
- When a file enters or leaves context during a session, the tree updates
  the color in real time

### 9. Session Context Selector

- Each project directory may contain an `agents/` subdirectory with one or
  more `.md` context files (e.g. `agents/security-review.md`,
  `agents/feature-build.md`)
- New backend route:
  - `GET /api/projects/:project/contexts` → scans `agents/` dir, returns
    list of `{ name, filename, preview }` objects
- Frontend new session flow:
  1. User clicks "New Session"
  2. Selects project (existing flow)
  3. If `agents/` dir has context files → present picker with preview
  4. If zero context files → skip, start session normally
  5. If one context file → auto-select, show confirmation
  6. Selected context content injected into Claude CLI via `--system-prompt`
     flag or session-scoped `CLAUDE.md`
- Session metadata stores `contextFile` field (filename of selected context)
- Session header displays: `[VM_ROLE] / [context name]`
  (e.g. "Designer / Security Review")
- Context files are read-only from the session selector — editing them is
  done via the file browser + markdown editor

**Directory convention:**
```
~/projects/myapp/
├── agents/
│   ├── feature-build.md      ← "You are building new features..."
│   ├── security-review.md    ← "You are auditing for vulnerabilities..."
│   └── refactor.md           ← "You are refactoring for performance..."
├── src/
├── CLAUDE.md
└── ...
```

### 10. Stale Context Detection

- Backend tracks which files Claude has read during the current session
  (parsed from Claude CLI tool call stream — file read events)
- Backend stores `{ filePath: lastReadTimestamp }` in session state
- New backend route:
  - `GET /api/session/:id/stale` → for each tracked file, compare
    `lastReadTimestamp` vs current `fs.stat().mtime`. Return list of
    stale files.
- Frontend polls `/api/session/:id/stale` on same 3s interval as file
  change polling
- Stale files get a warning icon in the file tree (alongside the accent
  color for context files)
- Chat header shows a dismissible banner listing stale files with a
  "Re-read" button that sends a message to Claude asking it to re-read
  the file

### 11. Architecture Viewer (`frontend/components/ArchitectureViewer.tsx`)

- New nav option or button in the file browser: "Architecture"
- Backend route: `GET /api/files/read?path=architecture/architecture.json`
  (uses existing file read endpoint)
- Frontend parses the JSON and renders an ASCII-art diagram in a
  `<pre>` block with monospace font:
  - Lists components with box-drawing characters
  - Shows connections as arrows between component names
  - Groups by infrastructure/host
- Example output:
  ```
  ┌─────────────┐     ┌──────────────┐
  │  Frontend    │────▶│  API Server  │
  └─────────────┘     └──────┬───────┘
                             │
                      ┌──────▼───────┐
                      │  Database    │
                      └──────────────┘
  ```
- No graph libraries. Pure string rendering.
- If `architecture.json` doesn't exist, show: "No architecture.json found
  in this project"

### 12. File Change Polling

- Frontend polls `GET /api/files/snapshot?path=<project-dir>` every 3
  seconds
- Backend returns a hash map: `{ "relative/path": mtime_ms }` for all
  files in the project
- Frontend compares against previous snapshot:
  - New files → refresh file tree
  - Changed files → refresh file tree + warn if file is open in editor
  - Deleted files → refresh file tree + close editor if deleted file was open
- Editor warning bar: "This file was modified externally. [Reload] [Dismiss]"
- Reload replaces editor content with fresh disk read and clears dirty state

### 13. Multi-Format File Editing

- Monaco Editor configured with language modes:
  - `.md` → markdown mode (existing)
  - `.json` → json mode (syntax highlighting, bracket matching)
  - `.txt` → plaintext mode
- File tree click behavior: `.md`, `.json`, `.txt` → open in editor.
  All other types → read-only preview (existing behavior).
- Markdown preview panel only shown for `.md` files. `.json` and `.txt`
  use full-width editor (no split view).
- Save and dirty state work identically across all three formats.

## Security Architecture

SpAIglass is designed around a **risk-avoidance architecture**: the relay is deliberately kept as thin and stateless as possible, so that even a fully compromised relay cannot access your code, conversations, or files.

### Threat Model

The relay is the only internet-facing component. Its attack surface is intentionally minimal:

| Threat | Mitigation |
|--------|-----------|
| Relay compromise exposes user data at rest | Relay stores no payload data — only GitHub identity (public info), connector tokens (hashed), collaborator records, and the audit log. No code, files, or conversations are ever stored or logged by the relay. |
| Traffic interception | All relay traffic is TLS-encrypted (HTTPS/WSS via Caddy). Browser-to-relay and VM-to-relay connections both use WSS. No plaintext data traverses the network at any point. |
| Unauthorized VM access | Each connector authenticates with a unique token. Browser sessions require GitHub OAuth. The relay validates both before routing any traffic. A valid session can only reach connectors owned by the authenticated user or shared with them as `editor`/`viewer`. |
| Lateral movement between VMs | VMs are isolated from each other. The relay routes traffic per-connector — there is no mechanism for one connector to reach another. Each VM's backend only serves its own project directories. |
| Path traversal / filesystem access | The backend's file API validates all paths against the current project directory. Symlink resolution and `..` traversal are rejected. Upload directories are temporary and not statically served. |
| Session hijacking | Auth cookies are httpOnly, secure-flagged, SameSite=Lax, and expire after 72 hours. Agent API keys are stored as SHA-256 hashes — the plaintext key is shown once at creation and never stored. |
| Relay MITM / impersonation | VMs connect outbound to the relay — no inbound ports are opened. The connector uses the relay's TLS certificate for authentication. DNS is served via Cloudflare. |
| **Compromised relay serves backdoored frontend bundle** | **The relay originates the JavaScript that runs in the user's browser. A compromised relay does not need to inspect WebSocket frames to read user input — it can serve a tampered bundle that captures keystrokes before they ever become a frame. CSP and SRI raise the cost of every other attack class but do NOT defend against this. Mitigation: independent bundle verification via `/api/health` reporting `{commit, frontend_sha256}`, plus Sigstore-backed release attestation tying each published bundle hash to its CI workflow (Phase 8 step 5 in [ROADMAP.md](ROADMAP.md)). Users with a threat model that cannot accept this assumption should self-host the relay — see SECURITY.md.** |

### Data Flow

```
Browser (anywhere)
    │
    │  HTTPS/WSS (TLS 1.3)
    ▼
SpAIglass Relay (spaiglass.xyz)
    │  Stateless routing proxy
    │  Stores: GitHub identity, connector tokens
    │  Does NOT store: code, files, conversations, prompts, responses
    │
    │  WSS (TLS 1.3, outbound from VM)
    ▼
VM Backend (your machine)
    │  Serves React frontend (static build)
    │  Manages file browser, editor, project discovery
    │  Spawns Claude CLI processes
    │
    ▼
Claude CLI (local to VM)
    │  All code execution happens here
    │  Conversation history stored locally (~/.claude/)
    │  API calls go directly to Anthropic (api.anthropic.com)
    └── Your code never leaves this machine
```

### What the relay knows

The relay sees WebSocket frames pass through it in real time. It does not parse, log, or store the content of these frames. The relay knows:

- **Who you are** — GitHub username (from OAuth)
- **Which VM you're connecting to** — connector ID (from the URL slug)
- **That traffic is flowing** — connection open/close events for health monitoring
- **Nothing about your code** — the relay is a dumb pipe for WebSocket frames

### What the relay does NOT know

- File contents on your VMs
- What you're saying to Claude
- What Claude is saying back
- Which files Claude is reading or writing
- Your Anthropic API key (stored on the VM, sent directly to Anthropic)

### Auditability

The relay is open source under the MIT License. The complete source is at [github.com/c0inz/spaiglass/tree/main/relay/src](https://github.com/c0inz/spaiglass/tree/main/relay/src). The relay codebase is approximately 800 lines of TypeScript across 8 files. There are no build steps, transpilation layers, or obfuscation. Anyone can read it in an afternoon and verify every claim made in this document.

Key files to audit:
- `tunnel.ts` — WebSocket routing logic (the core of what the relay does)
- `db.ts` — SQLite schema showing exactly what is persisted
- `auth.ts` — OAuth flow and token exchange
- `connectors.ts` — Connector registration and .env generation
- `middleware.ts` — Rate limiting and session validation

### Encryption

| Segment | Protocol | Certificate |
|---------|----------|-------------|
| Browser → Relay | HTTPS / WSS | Let's Encrypt via Caddy (auto-renewed) |
| VM → Relay | WSS | Same relay certificate, validated by Node.js TLS |
| VM → Anthropic API | HTTPS | Anthropic's certificate (api.anthropic.com) |

All three segments are independently TLS-encrypted. There is no segment where data travels in plaintext.

### VM-side security boundaries

- File API restricted to project directory (path traversal protection)
- Upload directory is temp, not served statically
- Auth cookie is httpOnly, signed with a secret
- No user data leaves the VM except to Anthropic's API (via Claude CLI)
- VMs connect outbound only — no inbound ports need to be opened

## Infrastructure Context

- Hosts can be on any network — no Tailscale, VPN, or special networking required
- All relay traffic is outbound from the host (single persistent WebSocket to `spaiglass.xyz`)
- Hosts can run Linux, macOS, or Windows side-by-side in the same fleet under one GitHub identity
- No inbound ports are opened on the host; the backend listens only on `127.0.0.1:8080`
