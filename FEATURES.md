# SpAIglass Features

SpAIglass is a browser-based interface for managing Claude Code instances across multiple VMs. It extends [claude-code-webui](https://github.com/sugyan/claude-code-webui) with file management, role-based sessions, fleet orchestration, and deployment tooling.

**Claude chat and markdown access from ANYWHERE.**

---

## Open Source & Security

- **Open source** — Released under the [MIT License](https://github.com/c0inz/spaiglass/blob/main/LICENSE). Full source at [github.com/c0inz/spaiglass](https://github.com/c0inz/spaiglass).
- **Risk-avoidance architecture** — The relay is a stateless routing proxy. It never stores, inspects, or logs your code, conversations, or files. All project data stays on your VMs. The relay only persists GitHub identity and connector tokens — the minimum needed to authenticate and route connections.
- **Fully auditable** — The relay is ~800 lines of TypeScript with minimal dependencies (Hono, SQLite, ws). Anyone can read the complete source and verify exactly what data flows through it.
- **Full encryption** — All traffic between your browser and the relay, and between VMs and the relay, is TLS-encrypted (HTTPS/WSS). No plaintext data ever traverses the network.
- **Outbound-only connectivity** — VMs connect outbound to the relay via WebSocket. No inbound ports, no firewall holes, no VPN required. Your VMs are never directly exposed to the internet.
- **Your data stays on your machine** — Claude Code runs locally on each VM. Your project files, conversation history, and session state never leave the VM. The relay routes keystrokes and text in real time — nothing is persisted.

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

## Themes

SpAIglass ships six themes plus a five-color picker for the 70s themes. Theme is persisted in `localStorage` (versioned settings, auto-migrated).

- **Light** — Bright default.
- **Dark** — Classic dark mode.
- **Glass** — Glassmorphism over the dark base: dark gradient background with cyan/purple radial highlights, frosted blur on panels, gradient accent buttons.
- **Plain** — Boring corporate light theme: removes gradients, mutes accent colors, squares off rounded corners.
- **70s Light** — Parchment background (`#f4ecd8`) with dark ink, IBM Plex Mono / VT323 typography, no rounded corners or shadows.
- **70s Dark** — CRT phosphor terminal: black background, monochrome glyphs in the selected phosphor color, monospace typography, faint glow via `text-shadow`.
- **Phosphor color picker** — When either 70s theme is active, the General Settings panel exposes a 5-swatch picker (green / amber / white / cyan / red) that drives every label, border, button outline, and accent through the `--phosphor` CSS variable.

## Multi-VM Fleet Management

Fleet management is built into the relay dashboard at `spaiglass.xyz` — no separate portal process.

- **One dashboard, all platforms** — Linux, macOS, and Windows hosts appear in the same connector list under one GitHub identity.
- **Add VM modal** — Click *Register VM*, enter a name, and the modal generates a one-time install token. Two tabs (Linux/macOS and Windows) provide a clipboard-ready one-line installer pre-filled with the token, connector id, and host name.
- **Live status** — Connector last-seen timestamps and online/offline indicators pulled from the relay's WebSocket registry.
- **Per-VM URLs** — Each connector renders as `https://spaiglass.xyz/vm/<github-login>.<vm-name>/`. Clicking opens the host's tunneled UI in the browser.
- **Version-skew banner** — The relay-served frontend polls `/api/release` and surfaces a per-VM warning when a backend reports an older release than the relay.
- **Connector lifecycle** — Rename, regenerate token, or delete connectors from the dashboard. Tokens are stored as SHA-256 hashes only.
- **Agent keys** — `sg_...` API keys (also stored hashed) let LLM agents and provisioning scripts hit `/api/connectors` without a browser session.

## Supported Host Platforms

SpAIglass spawns sessions through the official **Anthropic Claude Code CLI**, so it runs anywhere the CLI does.

| Platform | Versions | Service mechanism | Installer |
|---|---|---|---|
| **Linux** | Ubuntu, Debian, Fedora, Arch — anything with bash, tar, node >= 20 | `systemd --user` unit with `loginctl enable-linger` | `curl -fsSL https://spaiglass.xyz/install.sh \| bash -s -- ...` |
| **macOS** | macOS 12+ on Intel or Apple Silicon | `launchd` LaunchAgent under `~/Library/LaunchAgents` | `curl -fsSL https://spaiglass.xyz/install.sh \| bash -s -- ...` |
| **Windows** | Windows 10 build 17063+ and Windows 11 | Per-user Scheduled Task that runs at logon (no admin) | `& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) ...` |

The Claude Code CLI must be installed and authenticated on the host first (`claude.ai/install.sh` on Linux/macOS, `claude.ai/install.ps1` on Windows). After that, run the spaiglass installer for the host platform.

## Deployment

### One-line installers

The relay generates these for you in the Add VM modal, but the form is the same for both browser and agentic enrollment.

**Linux / macOS:**
```bash
curl -fsSL https://spaiglass.xyz/install.sh | bash -s -- \
    --token=TOKEN --id=CONNECTOR_ID --name=HOST_NAME
```

**Windows 10 / 11 (PowerShell, no admin):**
```powershell
& ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) `
    -Token TOKEN -Id CONNECTOR_ID -Name HOST_NAME
```

What the installers do:
- Download a slim ~130 KB tarball containing only the backend (the relay serves the frontend, so hosts never ship `dist/`)
- Run `npm install --omit=dev`
- Write a per-user `.env` with the connector id, token, and relay URL
- Install a per-user service that launches at boot/logon (no admin/sudo required)
- Restart the service if a previous install exists (idempotent — re-run to upgrade in place)
- Pass `--uninstall` (or `-Uninstall` on Windows) to remove the install and the service

### Agentic enrollment

For LLM agents and provisioning scripts, the relay also exposes:

- `POST /api/auth/token-exchange` — exchange a GitHub PAT for a reusable `sg_...` agent key
- `POST /api/connectors` — register a host and get a one-time install token
- `GET /api/setup` — machine-readable setup instructions (same content as the human `/setup` page)

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SPAIGLASS_RELAY_URL` | Yes | (set by installer) | `wss://spaiglass.xyz` |
| `SPAIGLASS_CONNECTOR_ID` | Yes | (set by installer) | UUID issued by `/api/connectors` |
| `SPAIGLASS_CONNECTOR_TOKEN` | Yes | (set by installer) | One-time token used to authenticate the WSS dial |
| `VM_ROLE` | No | Agent | Role label shown in the header |
| `PORT` | No | 8080 | Backend port (bound to `127.0.0.1` only) |
| `CLAUDE_WORKING_DIR` | No | `$HOME` | Project root surfaced to the file browser |

See `.env.example` for a template.

## Layout

- **Three-panel split** — Sidebar (left, 224px) | Editor/Arch (middle, flex) | Chat (right, 300px when editor open, flex when closed)
- **Responsive** — Chat panel expands to full width when no file is open.
- **Header** — Pinned at top with Spyglass title, VM role, active context name, and buttons for folder, arch, history, and settings.
