# Phase 1 Specification: VM-Side WebUI

## Overview

Fork and extend `sugyan/claude-code-webui` into a full-featured browser interface
for Claude CLI running on Ubuntu VMs. The application runs entirely on the VM.
The browser connects to it either directly (local/Tailscale) or via the Phase 2
relay server (public access).

---

## Repository Setup

1. Fork `https://github.com/sugyan/claude-code-webui`
2. Clone to VM at `/home/<user>/claude-webui`
3. All modifications are additions only - do not rewrite existing functionality
4. Keep upstream changes mergeable - new files in new locations, minimal edits to existing files

---

## Environment Variables

All configuration via environment variables. Document in `.env.example`.

```bash
# Required
AUTH_PASSWORD=           # Password for WebUI login page
VM_ROLE=                 # Display name e.g. "Designer", "Security Auditor"

# Optional
PORT=8080                # Backend port (default: 8080)
HOST=0.0.0.0             # Bind address (default: 0.0.0.0)
VM_NAME=                 # Machine name shown in UI (default: hostname)
PROJECTS_ROOT=           # Root directory for file browser (default: $HOME/projects)
SESSION_SECRET=          # Secret for signing session cookies (auto-generated if not set)
UPLOAD_DIR=/tmp/claude-uploads  # Temp directory for uploaded files

# Relay mode (Phase 2 integration)
RELAY_URL=               # wss://relay.example.com - if set, runs in relay mode
RELAY_TOKEN=             # User token from relay server registration
```

---

## Backend Additions

### File Structure

```
backend/
├── handlers/
│   ├── chat.ts          ← EXISTING - do not modify unless adding file delivery hook
│   ├── projects.ts      ← EXISTING
│   ├── files.ts         ← NEW
│   ├── upload.ts        ← NEW
│   └── config.ts        ← NEW
├── middleware/
│   └── auth.ts          ← NEW
├── relay/
│   └── connector.ts     ← NEW (relay mode)
└── index.ts             ← MODIFY - add new routes and middleware
```

---

### 1. Auth Middleware (`backend/middleware/auth.ts`)

Password-based authentication with session cookie.

**Behaviour:**

- All routes except `/login` and `/api/auth/*` require valid session cookie
- Session cookie name: `cwui_session`
- Cookie is `httpOnly`, `sameSite: strict`, signed with `SESSION_SECRET`
- Session expires after 30 days of inactivity
- If `AUTH_PASSWORD` is not set, auth is disabled (warn in console on startup)

**Routes to add in `index.ts`:**

```
GET  /login              Serve login HTML page
POST /api/auth/login     Validate password, set cookie, return 200 or 401
POST /api/auth/logout    Clear cookie, return 200
GET  /api/auth/status    Return { authenticated: boolean }
```

**Login page (`frontend/login.html`):**

- Minimal HTML, no React dependency
- Single password input, submit button
- Shows error message on failed attempt
- Redirects to `/` on success
- Styled to match app theme (dark background, same font)

---

### 2. Config Endpoint (`backend/handlers/config.ts`)

Exposes VM metadata to the frontend.

```
GET /api/config
```

Response:

```json
{
  "vmRole": "Designer",
  "vmName": "designer-01",
  "projectsRoot": "/home/user/projects",
  "relayMode": false,
  "version": "1.0.0"
}
```

---

### 3. File Handler (`backend/handlers/files.ts`)

Provides filesystem access scoped to the projects root directory.

**Security rule:** Every path parameter must be validated to be within
`PROJECTS_ROOT`. Reject any path containing `..` or resolving outside the root.
Return 403 on violation. Never expose this error detail to the client.

#### Endpoints

```
GET  /api/files/tree
```

Query params: `path` (optional, defaults to PROJECTS_ROOT)
Returns one level of directory listing.

Response:

```json
{
  "path": "/home/user/projects/alpha",
  "entries": [
    {
      "name": "AGENT.md",
      "type": "file",
      "size": 2048,
      "modified": "2026-04-01T10:00:00Z"
    },
    { "name": "src", "type": "directory", "childCount": 12 },
    {
      "name": "README.md",
      "type": "file",
      "size": 512,
      "modified": "2026-03-28T09:00:00Z"
    }
  ]
}
```

```
GET  /api/files/read
```

Query params: `path` (required, full path to file)
Returns file contents as plain text.
Maximum file size: 2MB. Return 413 if exceeded.

Response:

```json
{
  "path": "/home/user/projects/alpha/AGENT.md",
  "content": "# Project Alpha\n...",
  "size": 2048,
  "modified": "2026-04-01T10:00:00Z"
}
```

```
POST /api/files/write
```

Body: `{ "path": "/absolute/path/file.md", "content": "..." }`
Writes content to file. Creates file if it does not exist.
Does not create directories - parent must exist.

Response: `{ "success": true, "modified": "2026-04-09T12:00:00Z" }`

```
GET  /api/files/download
```

Query params: `path` (required)
Streams file as download. Sets `Content-Disposition: attachment`.
Supports all file types.

---

### 4. Upload Handler (`backend/handlers/upload.ts`)

Handles image uploads from the chat input.

```
POST /api/upload
```

Content-Type: `multipart/form-data`
Field name: `file`
Accepted types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
Max file size: 10MB

Saves to `UPLOAD_DIR` with a UUID filename preserving extension.

Response:

```json
{
  "uploadId": "a3f9x2k1",
  "path": "/tmp/claude-uploads/a3f9x2k1.png",
  "filename": "screenshot.png",
  "mimeType": "image/png",
  "size": 204800
}
```

Uploaded files are served at:

```
GET /api/upload/:uploadId
```

Returns the file with correct Content-Type header.

Cleanup: files older than 24 hours in UPLOAD_DIR are deleted on startup.

---

### 5. Chat Handler Modification (`backend/handlers/chat.ts`)

Add file delivery detection to the existing streaming handler.

**Do not rewrite this file.** Add a thin wrapper around the existing message stream
that watches for tool call results indicating file writes.

When a `tool_result` message appears in the stream where the tool name is
`write_file`, `str_replace_editor`, or similar file-writing tools, inject
an additional message into the NDJSON stream:

```json
{
  "type": "file_created",
  "path": "/home/user/projects/alpha/output.md",
  "filename": "output.md",
  "extension": "md"
}
```

The frontend handles this message type to show the file delivery UI.

---

### 6. Relay Connector (`backend/relay/connector.ts`)

Only activated when `RELAY_URL` and `RELAY_TOKEN` are set.

When relay mode is active:

- Do NOT bind HTTP server to a port
- Connect to `RELAY_URL` via WebSocket
- Send auth handshake: `{ "type": "connector_auth", "token": "RELAY_TOKEN" }`
- Wait for `{ "type": "auth_ok", "channelId": "..." }`
- On each incoming relay message (HTTP request), handle it locally and return response
- Maintain connection with ping/pong every 30 seconds
- Reconnect with exponential backoff on disconnect (1s, 2s, 4s, 8s, max 60s)

**Message protocol (relay ↔ connector):**

Incoming request from relay:

```json
{
  "type": "http_request",
  "requestId": "req_abc123",
  "method": "GET",
  "path": "/api/files/tree",
  "query": "path=/projects/alpha",
  "headers": { "cookie": "..." },
  "body": null
}
```

Connector response to relay:

```json
{
  "type": "http_response",
  "requestId": "req_abc123",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"entries\": [...]}"
}
```

For streaming responses (chat):

```json
{
  "type": "stream_chunk",
  "requestId": "req_abc123",
  "chunk": "data: {...}\n\n"
}
```

```json
{
  "type": "stream_end",
  "requestId": "req_abc123"
}
```

---

## Frontend Additions

### File Structure

```
frontend/src/
├── components/
│   ├── FileSidebar/
│   │   ├── FileSidebar.tsx     ← NEW
│   │   ├── FileTree.tsx        ← NEW
│   │   └── FileTreeNode.tsx    ← NEW
│   ├── MarkdownEditor/
│   │   ├── MarkdownEditor.tsx  ← NEW
│   │   └── EditorToolbar.tsx   ← NEW
│   ├── ImageUpload.tsx         ← NEW
│   ├── FileDelivery.tsx        ← NEW
│   └── RoleHeader.tsx          ← NEW
└── hooks/
    ├── useFileTree.ts          ← NEW
    └── useConfig.ts            ← NEW
```

---

### 1. Role Header (`frontend/src/components/RoleHeader.tsx`)

Replaces or wraps the existing header component.

Calls `GET /api/config` on mount.

Displays:

- VM role name (large, prominent): e.g. "Designer"
- VM name (smaller, subdued): e.g. "designer-01"
- Connection status indicator: green dot (connected) / red dot (relay disconnected)
- Current project name (from existing project selector)

Sets `document.title` to `"[VM Role] - Claude WebUI"` e.g. `"Designer - Claude WebUI"`

---

### 2. File Sidebar (`frontend/src/components/FileSidebar/`)

Collapsible sidebar panel on the left side of the layout.

**FileSidebar.tsx:**

- Toggle button to show/hide (default: visible on desktop, hidden on mobile)
- Header showing current project path
- Refresh button
- Mounts FileTree at the project root

**FileTree.tsx:**

- Calls `GET /api/files/tree?path=<dir>` to load one level
- Renders list of FileTreeNode components
- Sorts: directories first, then files, both alphabetically

**FileTreeNode.tsx:**

- Directory: shows folder icon, name, expand/collapse chevron
  - On expand: calls `GET /api/files/tree?path=<subdir>`, renders children
  - Lazy load - only fetches when expanded
- File: shows file icon (different icon for `.md` vs other types), name
  - `.md` file clicked: calls `onOpenEditor(path)`
  - Other file clicked: calls `onOpenPreview(path)`
- Selected state: highlighted background on the open file
- File icons: use simple emoji or heroicons (already a dependency)
  - `.md` files: document icon
  - images: photo icon
  - other: generic file icon

**Auto-refresh:**

- When a `file_created` message arrives in the chat stream, call refresh on the
  parent directory of the created file
- Refresh button manually refreshes the entire tree from root

---

### 3. Markdown Editor (`frontend/src/components/MarkdownEditor/`)

Panel that opens when a `.md` file is selected in the file tree.

**MarkdownEditor.tsx:**

Dependencies to install:

- `@monaco-editor/react` - the editor component
- `react-markdown` - for the preview pane
- `remark-gfm` - GitHub Flavored Markdown support for preview

Layout: Two-column split. Left: Monaco editor. Right: rendered preview.
On mobile (< 768px): single column, tabs to switch between edit and preview.

**Behaviour:**

- On open: calls `GET /api/files/read?path=<path>`, loads content into editor
- Monaco editor language: `markdown`
- Monaco theme: matches app theme (dark/light)
- Preview pane re-renders on every keystroke (debounced 300ms)
- Dirty state: if content differs from loaded content, show unsaved indicator
  (dot in tab title, "Unsaved changes" text near save button)
- Save: calls `POST /api/files/write`, clears dirty state on success
- Keyboard shortcut: `Ctrl+S` / `Cmd+S` triggers save
- Close button: if dirty, show confirmation dialog before closing
- Error handling: show toast notification on save failure

**EditorToolbar.tsx:**

- File name (read-only display)
- Unsaved indicator
- Save button
- Close button
- Toggle preview button (mobile only)

---

### 4. Image Upload (`frontend/src/components/ImageUpload.tsx`)

Integrated into the existing chat input area.

**UI:**

- Paperclip icon button next to the message input
- Clicking opens native file picker (accept: `image/*`)
- Drag-and-drop onto the chat window also triggers upload
- After selection: calls `POST /api/upload`
- While uploading: shows spinner on the icon
- After upload: shows thumbnail preview above the input bar
- Multiple images can be queued (show row of thumbnails)
- Each thumbnail has an X button to remove it before sending
- On message send: include `uploadIds` array in the chat API request

**Modify existing chat request handler:**
Include uploaded image paths in the Claude query. Pass them as image content
blocks in the message to Claude (Claude supports multiple images per message).

---

### 5. File Delivery (`frontend/src/components/FileDelivery.tsx`)

Renders inside the chat message list when a `file_created` event is received.

Displayed as a distinct message bubble (different background colour from
Claude text responses, e.g. subtle border-left accent).

**For `.md` files:**

```
┌─────────────────────────────────────────┐
│ 📄 Claude created: output.md            │
│                                         │
│ [Open in Editor]  [Download]            │
│                                         │
│ ▼ Preview (click to expand)             │
│   # Output                              │
│   First few lines of the file...        │
└─────────────────────────────────────────┘
```

**For image files:**

```
┌─────────────────────────────────────────┐
│ 🖼 Claude created: screenshot.png       │
│ [rendered image inline, max 400px wide] │
│ [Download]                              │
└─────────────────────────────────────────┘
```

**For other files:**

```
┌─────────────────────────────────────────┐
│ 📎 Claude created: report.json          │
│ [Download]                              │
└─────────────────────────────────────────┘
```

Open in Editor calls the same handler as clicking a `.md` file in the sidebar.
Download calls `GET /api/files/download?path=<path>`.

---

## Layout Changes

The existing layout is a single-column chat view. Extend to three-panel layout:

```
┌──────────────────────────────────────────────────┐
│  RoleHeader (VM Role + project name + status)     │
├───────────┬──────────────────────┬───────────────┤
│           │                      │               │
│  File     │   Chat Panel         │  Markdown     │
│  Sidebar  │   (existing)         │  Editor       │
│           │                      │  (opens on    │
│  (toggle) │                      │  file select) │
│           │                      │               │
└───────────┴──────────────────────┴───────────────┘
```

- File sidebar: 260px wide, collapsible
- Chat panel: flex-grow, minimum 400px
- Markdown editor: 500px wide, only shown when a file is open, collapsible
- On tablet (< 1024px): editor overlays the chat panel as a drawer
- On mobile (< 768px): sidebar and editor are full-screen overlays accessed via buttons

---

## Systemd Service

Create `/etc/systemd/system/claude-webui.service`:

```ini
[Unit]
Description=Claude WebUI
After=network.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/claude-webui
EnvironmentFile=/home/<user>/claude-webui/.env
ExecStart=/usr/bin/node backend/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

And a setup script `scripts/install-service.sh` that:

1. Copies `.env.example` to `.env` if not exists
2. Prompts for `AUTH_PASSWORD` and `VM_ROLE` if not set in `.env`
3. Runs `npm install && npm run build`
4. Writes the systemd service file with the correct username
5. Runs `systemctl enable claude-webui && systemctl start claude-webui`
6. Prints the Tailscale IP and access URL

---

## Testing Checklist

Before Phase 2 integration:

- [ ] Login page appears on unauthenticated access
- [ ] Wrong password shows error, correct password grants access
- [ ] VM role and name appear in header and browser tab
- [ ] File tree loads and expands correctly
- [ ] `.md` file opens in editor, preview renders correctly
- [ ] Ctrl+S saves file, dirty indicator clears
- [ ] Unsaved close shows confirmation dialog
- [ ] Image upload shows thumbnail, sends with message
- [ ] Claude receives image and references it in response
- [ ] File delivery message appears when Claude writes a file
- [ ] Open in Editor from file delivery works
- [ ] File tree refreshes when Claude writes a file
- [ ] Mobile layout: chat usable in Safari on iPhone
- [ ] Systemd service starts on boot, restarts on crash
- [ ] All file paths validated, `../` traversal returns 403
