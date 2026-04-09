# Tasks

## Status Key
- [ ] Not started
- [~] In progress
- [x] Complete

---

## Phase 1 - Environment Setup

- [x] Confirm Node.js 20+ installed (v25.5.0)
- [x] Confirm Claude CLI installed and authenticated (v2.1.97)
- [ ] Confirm Tailscale is installed and connected on the target VM
- [x] Fork https://github.com/sugyan/claude-code-webui → c0inz/spyglass
- [x] Clone spyglass to ~/projects/spyglass
- [x] Run `npm install` in both `backend/` and `frontend/` directories
- [x] Confirm base app runs and Claude chat works

## Phase 2 - Core Additions

- [x] **Auth middleware** (`backend/middleware/auth.ts`)
- [x] **VM Role display** (`backend/handlers/config.ts` + `frontend/hooks/useVmConfig.ts`)
- [x] **File browser backend** (`backend/handlers/files.ts`)
      Routes: tree, read, write, snapshot, list
- [x] **File browser frontend** (`frontend/components/FileSidebar.tsx`)
      Tree tab + Context tab with count badge, ordered by last touch
- [x] **File editor** (`frontend/components/FileEditor.tsx`)
      Monaco Editor. .md/.json/.txt editable, others read-only. Ctrl+S. Dirty indicator.
      No markdown preview — all files are plain text editor.
- [x] **Session context selector** (`backend/handlers/contexts.ts` + `frontend/components/NewSessionDialog.tsx`)
      Skipped when role is set via URL param from portal.
      Shows picker only when no role in URL and agents/ dir has files.
- [x] **Context file highlighting in file tree**
      Blue filenames for context files in sidebar and @-mention dropdown.
- [x] **@-mention file references in chat** (`frontend/components/FileMention.tsx`)
      @ trigger, filterable dropdown, keyboard nav, insert path.
- [x] **Stale context detection** (`backend/handlers/stale.ts` + `frontend/components/StaleContextBanner.tsx`)
      Yellow banner when context files change on disk.
- [x] **Architecture viewer** (`frontend/components/ArchitectureViewer.tsx`)
      ASCII-art from architecture/architecture.json. Arch button in header.
      Opening a file closes the arch viewer (shared middle panel).
- [x] **File change polling** (`frontend/hooks/useFilePolling.ts`)
      3s polling, auto-refresh sidebar, warn on editor conflicts.
- [x] **Multi-format file editing**
      Monaco language modes: markdown, json, plaintext. Green icons for editable files.

## Phase 3 - Media and File Delivery

- [x] **Image upload** (`backend/handlers/upload.ts` + `frontend/components/chat/ChatInput.tsx`)
      Paperclip button in chat bar. POST to `/api/upload` (multipart).
      Saves to `.spyglass/uploads/`. Thumbnail strip above input.
      Image path prepended to message for Claude.

- [x] **File delivery from Claude** (`backend/handlers/chat.ts` + `frontend/src/components/MessageComponents.tsx`)
      Backend detects Write/Edit tool_use, injects `file_delivery` stream events.
      Frontend renders FileDeliveryMessage with Open/Download buttons.
      Open loads file in editor. Auto-refreshes file tree on file delivery.

## Phase 4 - Deployment and Fleet Portal

- [x] **Health endpoint** (`backend/handlers/config.ts`)
      `GET /api/health` → `{ "status": "ok", "role": "<VM_ROLE>" }`

- [x] **Session persistence** (`backend/handlers/session.ts`)
      POST /api/session/save writes `~/.claude-webui/last-session.json`.
      GET /api/session/last reads it (24h expiry, project-scoped).
      Frontend saves on session start, auto-resumes on page load.

- [x] **Systemd services** (`systemd/`)
      Three unit files (backend, frontend, portal) + spyglass.target.
      `systemd/install.sh` copies units, enables, starts on boot.
      Auto-restarts on crash.

- [x] **`.env.example`** documenting all env vars (VM_ROLE, AUTH_PASSWORD, PORT, HOST, DEBUG)

- [x] **Deployment script** (`deploy-webui.sh`)
      Takes --host, --role, --password, --ssh-key. SSHes into VM, clones/pulls,
      installs deps, writes .env, installs systemd services, starts.
      Supports --manifest for bulk deploy from JSON array.

- [x] **Discovery endpoint** (`backend/handlers/discover.ts`)
      Scans projectsDir for projects with agents/*.md.

- [x] **Fleet portal** (`portal/`)
      Node server (serve.js) on port 9090.
      Reads fleet.json → queries /api/discover → renders Server + Role rows.
      Filter search. Red X to hide roles. Create new roles from unassigned projects.
      fleet.json persisted via PUT.

- [x] **Session context lockdown**
      Role loaded from URL param (?role=developer.md). No mid-session switching.
      Header shows project path + role. File browser scoped to project.

- [ ] **Test on second VM** (manual — use deploy-webui.sh)

## Phase 5 - Polish

- [ ] Mobile test on iPhone - confirm chat usable in Safari
- [ ] Test image upload end to end
- [ ] Test file delivery when Claude writes a `.md` file
- [ ] Confirm chat history persists across browser sessions

---

## Running Services (Super-Server)

Backend: `cd ~/projects/spyglass/backend && VM_ROLE="DevOps" npx tsx cli/node.ts --host 0.0.0.0 --port 8080 --claude-path /home/johntdavenport/.local/bin/claude`
Frontend: `cd ~/projects/spyglass/frontend && npx vite --host 0.0.0.0 --port 3000`
Portal: `cd ~/projects/spyglass/portal && node serve.js` (port 9090)

## Layout Notes

- Vertical split: sidebar (left, w-56) | editor/arch (middle, flex-1) | chat (right, w-300 when editor open, flex-1 when closed)
- Header pinned at top with Spyglass title, VM role, context name, folder/arch/history/settings buttons
- All Claude sessions use --dangerously-skip-permissions (set in chat.ts)
- Portal at http://192.168.1.153:9090
- Spyglass at http://192.168.1.153:3000

## Environment Variables Reference

| Variable | Required | Example | Description |
|---|---|---|---|
| AUTH_PASSWORD | No | mysecretpass | Password for WebUI login (skipped if unset) |
| VM_ROLE | Yes | Designer | Role shown in header |
| PORT | No | 8080 | Backend port (default 8080) |
| HOST | No | 0.0.0.0 | Bind address (default 127.0.0.1) |
