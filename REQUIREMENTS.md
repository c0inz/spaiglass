# Requirements

## Access

- Must work in any browser (Chrome, Safari, Firefox) on any operating system
- Must work on Windows laptops from any network (home, office, coffee shop, travel)
- Must work on iPhone from any network (Safari and Chrome)
- No client software installation required on user devices beyond a browser
- No SSH, no terminal, no command-line interaction for day-to-day use
- Access secured via Tailscale - only devices on the user's Tailscale network
  can reach the WebUI

## Project and Session Management

- One WebUI instance per VM
- Each VM has a defined Claude role (designer, security, backend, etc.)
- The VM role is displayed clearly in the browser tab / page header
- User can select which project directory Claude works in from the UI
- Each project maintains its own persistent chat history
- Chat history is scrollable and resumable - user can return to any past session
- Switching projects does not carry over context from the previous project

## Chat Interface

- Clean chat interface, messages displayed clearly
- Streaming responses - Claude's reply appears word by word as it generates
- User can upload one or more photos/images into the chat message
- Images are displayed inline in the chat when uploaded
- Claude can reference uploaded images in its response
- When Claude writes or modifies a file during a task, the file is surfaced
  in the chat as a downloadable/viewable attachment
- When Claude takes a screenshot or generates an image, it appears inline
  in the chat
- `.md` files returned by Claude are rendered as formatted Markdown in the chat,
  with an option to open them in the editor
- Ability to cancel a running Claude response
- Mobile: chat is fully usable on iPhone in both portrait and landscape

## File Browser

- Sidebar panel showing the directory tree of the current project on the VM
- User can expand/collapse directories
- Clicking a `.md` file opens it in the editor panel
- Other file types are visible in the tree but clicking them shows a read-only
  preview, not an editor
- File tree refreshes when Claude creates or modifies files
- Files currently loaded into the session context are displayed with an
  accent-colored filename (visually distinct from non-context files)
- The accent color is consistent between the file tree and the `@`-mention
  dropdown in the chat input

## File Mentions in Chat

- Typing `@` in the chat input triggers a dropdown of project files
- The dropdown is filterable — continue typing after `@` to narrow results
- Selecting a file inserts its path into the chat message
- Files currently in the session context are pinned to the top of the
  dropdown and shown with the same accent color used in the file tree
- The `@`-mention dropdown must work on both desktop and mobile (no hover
  dependency)
- Multiple files can be mentioned in a single message

## File Editor

- When a `.md`, `.json`, or `.txt` file is opened, it displays in an editor panel
- Full-width text editor with syntax highlighting (Monaco Editor)
- No rendered preview — files are plain text consumed by Claude
- Save button writes the file back to the VM filesystem
- Unsaved changes indicated with visual dot
- Ctrl+S / Cmd+S keyboard shortcut to save
- Editor is usable on a laptop - phone editing is not a priority

## Authentication

- Simple password protection on the WebUI backend
- Password set via environment variable at startup
- Unauthenticated requests are redirected to a login page
- Session persists for the browser session (no repeated logins)
- This is a single-user system - no multi-user account management needed

## VM Role Display

- The VM's role name is configured at startup (e.g. "Designer", "Security Auditor")
- Role name appears in the page header and browser tab title
- Makes it immediately obvious which Claude instance you are talking to
  when multiple tabs are open

## Session Context Selection

- When starting a new chat session, the user selects a **context file** that
  defines what the agent focuses on for that session
- Context files are `.md` files located in an `agents/` subdirectory within
  each project directory (e.g. `~/projects/myapp/agents/security-review.md`)
- If a project has no `agents/` directory or no context files, the session
  starts with no injected context (base Claude behavior)
- If a project has exactly one context file, it is auto-selected (no prompt)
- If a project has multiple context files, the user picks one from a list
  before the session begins
- The selected context file's contents are injected as system-level
  instructions for the Claude CLI session
- The context name (derived from filename) is displayed in the session header
  alongside the VM role, so the user always knows which persona is active
- Context selection is per-session — switching context requires starting a
  new session
- The user can preview the context file contents before confirming selection

## Stale Context Detection

- When Claude has loaded files into its session context, track the last-modified
  time of those files
- If a file is modified externally (by another agent, git pull, manual edit)
  after Claude last read it, show a warning indicator on that file in the
  file tree and in the chat header
- Warning text: "file.md changed since Claude last read it"
- The user can click the warning to ask Claude to re-read the file, or dismiss it
- This prevents working with stale context without realizing it

## Architecture Viewer

- Simple, read-only view of the project's `architecture.json` if one exists
  in the project directory
- Renders component relationships as ASCII-art diagrams in a monospace panel
- No graph libraries, no SVG, no canvas — just formatted text showing
  components, their connections, and which infrastructure they run on
- If no `architecture.json` exists, the screen shows a placeholder message
- This is a v1 — intentionally minimal

## File Change Polling

- The frontend polls for filesystem changes every 3 seconds
- When a file in the current project directory is modified externally
  (outside of Claude or the WebUI editor), the file tree auto-refreshes
- If the currently open editor file changed on disk, show a warning bar:
  "This file was modified externally. Reload?"
- Prevents the user from overwriting external changes or missing new files

## Multi-Format File Editing

- The editor supports `.md`, `.json`, and `.txt` files (not just `.md`)
- `.json` files get basic syntax highlighting in Monaco
- `.txt` files open in plain text mode
- All three formats support save (Ctrl+S / Cmd+S) and dirty state indicator
- The file tree allows clicking any of these types to open in the editor
- Other file types remain read-only preview

## Fleet Portal

- A single landing page running on one known machine (Super-Server)
- Reads `fleet.json` for the list of servers (name, url, projectsDir)
- On load, queries each server's `/api/discover` endpoint to get available
  projects and roles
- A project is any directory under `projectsDir` that contains an
  `agents/` subdirectory with one or more `.md` files
- Each `.md` file in `agents/` represents a role (filename = role name)
- The portal renders a hierarchical list:
  Server → Project → Role
- Each project/role row is clickable — opens Spyglass in a new tab with
  that project directory and role context pre-loaded
- After creating a role for a project, the server still appears in the
  list for other potential roles. The created role becomes its own row.
- If a server has no discovered projects/roles, clicking the server row
  prompts the user to:
  1. Pick a project directory from the server's projects list
  2. Name a role
  3. System creates `agents/<rolename>.md` in that project
  4. Opens the session with that project and role loaded
- **Filter search**: A text field at the top of the list filters rows by
  matching typed text against server name, project name, or role name
- **Hide roles**: Each row has a red X button. Clicking it pops a
  confirmation dialog: "Hide <project> / <role>?" If confirmed, updates
  `fleet.json` to set `hidden: true` on that role. Hidden roles do not
  appear in the list unless a "show hidden" toggle is enabled.
- `fleet.json` supports a `hidden` array of `{ project, role }` objects
  to track which rows are suppressed
- Online/offline status via `/api/health` ping on each server
- The portal has its own password (same `AUTH_PASSWORD` pattern)
- User bookmarks one URL to access the entire fleet

## Session Context Rules

- You cannot change the project or role context of a session in flight
- To switch context, close the current session and pick a new
  project/role from the portal
- The Spyglass header displays the full project path and role so the
  user always knows what context is active
- The file browser only shows files from the selected project directory,
  not the entire home directory or filesystem
- The user can view and edit Claude behavioral `.md` files (CLAUDE.md
  and similar) through the file browser and editor — these are visible
  in the file tree alongside project files

## Session Persistence

- Each VM's WebUI remembers the last-used project, context file, and session
- On page load: if a previous session exists, auto-resume it immediately
  (same project, same context, same chat history). No picker, no questions.
- User sees the chat exactly where they left off
- "New Session" button always available in the header to start fresh
  with project/context picker
- When starting a new session, old sessions remain accessible in history
- This is the default behavior — 90% of visits are resumptions, not new sessions
- Backend persists last session state to a JSON file on disk (one file per VM)

## Deployment

- A single deployment script runs from Super-Server
- Takes target VM address, role name, and password as arguments
- SSHes into the VM, clones the repo, installs dependencies, creates
  systemd service with correct environment variables, and starts it
- Can be run in a loop over a fleet manifest file to deploy to all VMs
- Updating: re-run the script to pull latest and restart the service

## Non-Requirements (explicitly out of scope)

- LLM provider switching (Claude only)
- GitHub repository browser (project files live on the VM)
- Multi-user access control
- Public internet exposure
- Mobile markdown editing
- Voice input
- YAML editing
