# Architecture

## Overview

**Spyglass** — fork of `sugyan/claude-code-webui` with added features. One deployment per VM.
Each deployment is a standalone Node.js process serving the full application.

```
User Browser (laptop or phone)
      │
      │  HTTPS via Tailscale
      ▼
WebUI Backend (Node.js + Hono) ← runs on Ubuntu VM
      │
      ├── Serves React frontend (static build)
      ├── /api/chat        → spawns Claude CLI process
      ├── /api/files       → reads/writes VM filesystem
      ├── /api/upload      → receives uploaded images
      └── /api/projects    → project directory management
      │
      ▼
Claude CLI (installed on same VM)
      │
      └── Works within selected project directory
```

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

## Fleet Portal

A minimal standalone app running on Super-Server (port 9090).

```
User Browser
      │
      │  http://<super-server-tailscale-ip>:9090
      ▼
Fleet Portal (Node.js + static HTML)
      │
      ├── Reads fleet.json for server list
      ├── Queries each server's /api/discover for projects + roles
      ├── Pings each server's /api/health for online/offline
      ├── Renders hierarchical list: Server → Project → Role
      └── Click a row → window.open(vm.url/projects/<path>?role=<file>)
```

**fleet.json:**
```json
{
  "servers": [
    { "name": "Super-Server", "url": "http://192.168.1.153:3000", "projectsDir": "/home/johntdavenport/projects" },
    { "name": "Designer-VM", "url": "http://100.x.x.x:3000", "projectsDir": "/home/readystack/projects" }
  ],
  "hidden": [
    { "server": "Super-Server", "project": "oldproject", "role": "deprecated-role" }
  ]
}
```

**Discovery endpoint (on each VM):**
- `GET /api/discover?projectsDir=<path>` → scans for projects with
  `agents/*.md` files:
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
      { "name": "spyglass", "path": "/home/johntdavenport/projects/spyglass" }
    ]
  }
  ```
- `projects` = directories with `agents/*.md` files (have roles)
- `unassigned` = directories without `agents/` (no roles yet)

**New role creation flow:**
When user clicks an unassigned project or a bare server:
1. Portal shows project picker (from `unassigned` list)
2. User names a role
3. `POST /api/files/write` creates `agents/<rolename>.md` in that project
4. Portal opens Spyglass with that project + role

The portal is auth-protected (same `AUTH_PASSWORD` pattern).

Each VM's WebUI adds:
- `GET /api/health` → `{ "status": "ok", "role": "Designer" }`
- `GET /api/discover` → project/role discovery (see above)

## Deployment

### Per-VM deployment script

```bash
# Usage from Super-Server:
./deploy-webui.sh --host <tailscale-ip> --role "Designer" --password "pass"

# Or bulk deploy from manifest:
./deploy-webui.sh --manifest fleet.json
```

The script:
1. SSHes into the target VM
2. Clones (or pulls) the repo to `~/claude-webui`
3. Runs `npm install`
4. Creates `/etc/systemd/system/claude-webui.service` with env vars
5. Enables and starts the service
6. Verifies `/api/health` responds

### Per-VM systemd service

```bash
# /etc/systemd/system/claude-webui.service
AUTH_PASSWORD=<password>
VM_ROLE=Designer
PORT=8080
HOST=0.0.0.0
CLAUDE_WORKING_DIR=/home/readystack/projects
```

Starts on boot via systemd. Restarts automatically on crash.

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

## Security Boundaries

- WebUI only accessible via Tailscale (firewall blocks port 8080 from public)
- File API restricted to project directory (path traversal protection)
- Upload directory is temp, not served statically
- Auth cookie is httpOnly, signed with a secret
- No user data leaves the VM except to Anthropic's API (via Claude CLI)

## Infrastructure Context

- Tailscale installed on all VMs and user devices
- Apache Guacamole running on Ubuntu host for full desktop access when needed
- VM setup script already exists (installs xRDP, Tailscale, Xfce)
- Guacamole setup script already exists
