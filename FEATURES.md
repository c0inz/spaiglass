# Spyglass Features

Spyglass is a browser-based interface for managing Claude Code instances across multiple VMs. It extends [claude-code-webui](https://github.com/sugyan/claude-code-webui) with file management, role-based sessions, fleet orchestration, and deployment tooling.

---

## Chat Interface

- **Streaming responses** — Real-time output from Claude Code CLI, rendered as structured messages (text, tool calls, tool results, thinking, todos)
- **Permission modes** — Toggle between normal, plan, and accept-edits modes (Ctrl+Shift+M or click to cycle)
- **Image upload** — Paperclip button in the chat bar opens a file picker. Selected images show as thumbnails above the input. On send, images are uploaded to the server and their paths are passed to Claude.
- **File delivery notifications** — When Claude writes or edits a file, a notification card appears in chat with the filename, full path, an Open button (loads the file in the editor), and a Download button.
- **@-mention file references** — Type `@` in the chat input to get a filterable dropdown of project files. Select a file to insert its path into your message. Context files are highlighted in blue.
- **Conversation history** — Browse and resume past sessions. History button in the header opens a searchable list of previous conversations.
- **Abort** — Stop button (or ESC) cancels a running request.

## File Browser

- **Tree view** — Collapsible directory tree in a sidebar (toggle with the folder button in the header). Lazy-loaded one level at a time.
- **Context tab** — Second tab in the sidebar shows files referenced in the current session context, ordered by last touch, with a count badge.
- **Context file highlighting** — Files that are part of the session context appear with blue filenames in both the tree and the @-mention dropdown.
- **File change polling** — The sidebar refreshes every 3 seconds. If a file you have open in the editor is modified externally, you get a conflict warning.

## File Editor

- **Monaco Editor** — Full-featured code editor in the middle panel. Supports markdown, JSON, and plaintext with syntax highlighting.
- **Editable vs read-only** — `.md`, `.json`, and `.txt` files are editable (shown with green icons). All others are read-only.
- **Save** — Ctrl+S saves the file. A dirty indicator shows unsaved changes.
- **Shared panel** — The editor and architecture viewer share the middle panel. Opening a file closes the arch viewer and vice versa.

## Architecture Viewer

- **ASCII diagrams** — Reads `architecture/architecture.json` and renders ASCII-art architecture diagrams in the middle panel.
- **Toggle** — Arch button in the header opens/closes the viewer.

## Session Context

- **Role-based sessions** — Each session loads a role definition from an `agents/*.md` file. The role determines the system prompt and working context for Claude.
- **URL-driven** — When launched from the fleet portal, the role is set via URL parameter (`?role=developer.md`). No picker prompt.
- **Context picker** — For direct access without a role in the URL, a dialog shows available roles from the project's `agents/` directory.
- **Lockdown** — Once a role is set, it cannot be changed mid-session. The header shows the project path and active role.
- **Stale context detection** — If a context file changes on disk during a session, a yellow banner appears with a button to ask Claude to re-read it.

## Session Persistence

- **Auto-save** — When Claude starts a new session, the session ID is saved to `~/.claude-webui/last-session.json`.
- **Auto-resume** — On page load, if no session ID is in the URL, the app checks for a saved session matching the current project. If one exists and is less than 24 hours old, it auto-resumes.

## Authentication

- **Password protection** — Set `AUTH_PASSWORD` environment variable to require a password. If unset, no auth is required.
- **Session cookie** — After login, a session cookie persists the auth state.

## VM Role Display

- **Header badge** — The VM's role (from `VM_ROLE` env var) is shown in the header next to the Spyglass title.
- **Health endpoint** — `GET /api/health` returns `{ "status": "ok", "role": "<VM_ROLE>" }` for monitoring and fleet portal status checks.

## Fleet Portal

A separate lightweight web app (port 9090) for managing multiple Spyglass instances across VMs.

- **Server list** — Reads `fleet.json` to display all registered servers with their health status.
- **Role discovery** — Queries each server's `/api/discover` endpoint to find projects with `agents/*.md` files.
- **Role rows** — Each server/project/role combination is a clickable row that opens Spyglass with the correct project and role pre-selected.
- **Search/filter** — Filter the list by server name, project, or role.
- **Hide roles** — Red X button to hide roles you don't need. Hidden state is persisted to `fleet.json`.
- **Create roles** — Create new role files for projects that don't have any yet.

## Deployment

### Systemd Services

Three unit files plus a grouping target:

- `spyglass-backend.service` — Backend API on port 8080
- `spyglass-frontend.service` — Vite dev server on port 3000
- `spyglass-portal.service` — Fleet portal on port 9090
- `spyglass.target` — Groups all three, enabled on boot

Install with `sudo bash systemd/install.sh`. Auto-restarts on crash.

### Deploy Script

`deploy-webui.sh` automates deployment to remote VMs via SSH.

**Single host:**
```
./deploy-webui.sh --host 192.168.1.200 --role Designer --password secret
```

**Bulk deploy from manifest:**
```
./deploy-webui.sh --manifest deploy-manifest.json
```

Manifest format:
```json
[
  { "host": "192.168.1.200", "role": "Designer", "password": "secret" },
  { "host": "192.168.1.201", "role": "QA" }
]
```

The script clones/pulls the repo, installs dependencies, writes `.env`, installs systemd services, starts everything, and verifies the health endpoint.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VM_ROLE` | Yes | Agent | Role label shown in header |
| `AUTH_PASSWORD` | No | (none) | Password for login |
| `PORT` | No | 8080 | Backend port |
| `HOST` | No | 127.0.0.1 | Bind address |
| `DEBUG` | No | false | Enable debug logging |

See `.env.example` for a template.

## Layout

- **Three-panel split** — Sidebar (left, 224px) | Editor/Arch (middle, flex) | Chat (right, 300px when editor open, flex when closed)
- **Responsive** — Chat panel expands to full width when no file is open.
- **Header** — Pinned at top with Spyglass title, VM role, active context name, and buttons for folder, arch, history, and settings.
