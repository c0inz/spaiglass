# SpAIglass API Reference

## Project Naming Model

SpAIglass uses three independent naming layers. Understanding their
relationships is critical for correct API usage.

| Name | Scope | Mutable | Storage | Used In |
|------|-------|---------|---------|---------|
| **Project name** | Per-project | **Immutable** | Filesystem directory basename | URLs, session keys, Claude history, all internal references |
| **Display name** | Per-project, per-VM | Editable | `~/.spaiglass/project-display-names.json` | Page header, fleet dropdown |
| **Tab title** | Per-connector (per-VM) | Editable | Relay SQLite DB | Browser tab |

### Project name (immutable)

The project name is the basename of the project directory on disk — for
example, `OCMarketplace` from `/home/readystack/projects/OCMarketplace`.

It is the **canonical, immutable identifier** used across the entire
system:

- URL path segments and relay routing (`/vm/{slug}/OCMarketplace-developer/`)
- Claude Code session keys (`local:{path}:{role}`)
- Claude Code history directories (`~/.claude/projects/...`)
- `~/.claude.json` project registry
- Fleet role entries (`project` field)
- All API path parameters and query values

**The project name cannot be changed.** It is derived directly from the
filesystem path and used as a stable key in Claude Code's own config,
history storage, and session resumption. Renaming the directory would
break:

- All existing session history (conversations become unreachable)
- Claude Code config references in `~/.claude.json`
- Relay URL routing (bookmarks and shared links stop working)
- Any in-progress sessions on that project

**To change the actual project name:** Delete the project and create a
new one with the desired name via `POST /api/projects/register`. This
starts fresh with no history. There is no migration path for sessions
because Claude Code's history is keyed by absolute path.

**To change what users see in the UI:** Set a display name via
`PUT /api/settings/project-display-name`. The display name appears in
the page header and fleet dropdown, but the underlying project name
remains unchanged in all API responses and URLs.

### Display name (mutable)

A user-editable cosmetic label for a project, stored on the VM backend.
Defaults to `null` (the UI falls back to the project name). All browsers
connecting to the same VM see the same display name.

Endpoints:
- `GET /api/settings/project-display-names` — read all
- `PUT /api/settings/project-display-name` — set or clear one

### Tab title (mutable)

A user-editable browser tab title, stored on the relay per connector
(per-VM). This is a connector-level setting — it applies to the entire
VM, not a specific project. Managed through the relay:

- `GET /api/__relay/self` — read current connector info including custom display name
- `PUT /api/__relay/self/display-name` — set or clear tab title

---

## VM Backend Endpoints

All endpoints below run on the SpAIglass host backend
(`127.0.0.1:8080`). When accessed through the relay, requests are
tunneled via `GET /vm/{slug}/api/...`.

### Projects

#### `GET /api/projects`

Returns projects registered in `~/.claude.json` that have history
directories (i.e., projects that have been used with Claude Code at
least once).

**Response:**
```json
{
  "projects": [
    {
      "path": "/home/readystack/projects/OCMarketplace",
      "encodedName": "OCMarketplace"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Absolute path to the project directory |
| `encodedName` | string | URL-safe project name for history lookups |

> **Note:** Projects without Claude history (never used) won't appear
> here. Use `/api/discover` to find all projects with role files.

#### `GET /api/discover?projectsDir=<path>`

Scans `projectsDir` for subdirectories containing agent role files.
Finds projects by filesystem scan regardless of whether they have Claude
history.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `projectsDir` | Yes | Absolute path or `~`-prefixed path to scan |

**Response:**
```json
{
  "projects": [
    {
      "name": "OCMarketplace",
      "path": "/home/readystack/projects/OCMarketplace",
      "roles": [
        {
          "name": "developer",
          "filename": "developer.md",
          "path": "/home/readystack/projects/OCMarketplace/.claude/agents/developer.md"
        }
      ]
    }
  ],
  "unassigned": [
    {
      "name": "experiments",
      "path": "/home/readystack/projects/experiments"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `projects[].name` | string | **Immutable project name** — directory basename |
| `projects[].path` | string | Absolute directory path |
| `projects[].roles` | array | Agent role files found in `.claude/agents/` or `agents/` |
| `unassigned` | array | Directories without any role files |

Role file lookup order: `.claude/agents/*.md` (native) then `agents/*.md`
(legacy). Files in both locations are deduplicated by filename.

#### `POST /api/projects/register`

Creates a project directory, role file, and registers with Claude Code
config. Idempotent — safe to call again on existing projects. Overwrites
the role file if it already exists.

**Request body:**
```json
{
  "name": "TrendZion",
  "role": "developer",
  "roleContent": "You are the developer for TrendZion.\n\n## Project Location\n~/projects/TrendZion/"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Project directory name. **Becomes the immutable project name.** Must match `[A-Za-z0-9][\w.-]{0,99}`. |
| `role` | Yes | Role filename (without `.md`). Same character constraints. |
| `roleContent` | No | Markdown content for the role file. Default template used if omitted. |

**Response:**
```json
{
  "ok": true,
  "project": "TrendZion",
  "role": "developer",
  "roleFile": "/home/readystack/projects/TrendZion/.claude/agents/developer.md",
  "projectDir": "/home/readystack/projects/TrendZion"
}
```

**What it creates:**
1. `~/projects/{name}/` — project directory
2. `~/projects/{name}/.claude/agents/{role}.md` — role file
3. Entry in `~/.claude.json` — Claude Code project registry
4. `~/.claude/projects/{encoded}/` — Claude Code project metadata

> **Important:** The `name` field becomes the permanent, immutable
> project name. Choose carefully — the only way to change it is to
> delete the project and create a new one.

### Roles & Contexts

#### `GET /api/projects/contexts?path=<project-dir>`

Returns agent role files for a project. Used by the session context
selector and relayed by the fleet endpoint.

**Response:**
```json
{
  "contexts": [
    {
      "name": "developer",
      "filename": "developer.md",
      "path": "/home/readystack/projects/OCMarketplace/.claude/agents/developer.md",
      "preview": "You are the developer for OCMarketplace..."
    }
  ]
}
```

#### `GET /api/roles?path=<project-dir>`

Returns role files with additional metadata (source location, plugin
config, preview).

**Response:**
```json
{
  "roles": [
    {
      "name": "developer",
      "filename": "developer.md",
      "path": "/home/readystack/projects/OCMarketplace/.claude/agents/developer.md",
      "source": "native",
      "plugins": {},
      "preview": "You are the developer for OCMarketplace..."
    }
  ],
  "globalPlugins": {}
}
```

| Field | Description |
|-------|-------------|
| `source` | `"native"` (from `.claude/agents/`) or `"legacy"` (from `agents/`) |
| `plugins` | Plugin enable/disable map from the role file's frontmatter |

#### `POST /api/roles`

Creates a new role file.

#### `PUT /api/roles/:name`

Updates an existing role file.

### Settings

#### `GET /api/settings/project-display-names`

Returns all project display names for this VM.

**Response:**
```json
{
  "displayNames": {
    "OCMarketplace": "OC Market",
    "TrendZion": "Trend Zion"
  }
}
```

Projects without a custom display name are omitted (the UI falls back
to the immutable project name).

#### `PUT /api/settings/project-display-name`

Sets or clears the display name for a project. Does not change the
underlying project name — only what the UI shows.

**Request body:**
```json
{
  "project": "OCMarketplace",
  "displayName": "OC Market"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `project` | Yes | The immutable project name (directory basename) |
| `displayName` | Yes | Custom label, or `null` to clear |

**Response:**
```json
{
  "ok": true,
  "project": "OCMarketplace",
  "displayName": "OC Market"
}
```

#### `GET /api/settings/anthropic-key`

Returns whether an Anthropic API key is configured (never returns the
full key).

**Response:**
```json
{ "hasKey": true, "masked": "sk-ant-a…xxxx" }
```

#### `POST /api/settings/anthropic-key`

Sets or clears the Anthropic API key. Validates against
`api.anthropic.com` before persisting.

### Health & Config

#### `GET /api/health`

Public endpoint (no auth required). Returns status, VM role, and version.

```json
{ "status": "ok", "role": "Developer", "version": "2026.04.16" }
```

#### `GET /api/config`

Returns runtime configuration for the frontend.

---

## Relay Endpoints

These endpoints are served by SGCleanRelay (`spaiglass.xyz`). They are
accessed from the browser as `/api/__relay/...` (the frontend's fetch
interceptor prepends `/vm/{slug}`).

### Fleet

#### `GET /api/__relay/fleet`

Returns all connectors the authenticated user owns or has access to.

**Response:**
```json
{
  "connectors": [
    {
      "id": "uuid",
      "name": "readystack.dev-vm-01",
      "displayName": "Dev VM 01",
      "role": "owner",
      "online": true
    }
  ]
}
```

#### `GET /api/__relay/fleet/{connectorName}/roles`

Returns all project roles available on a specific connector (VM). The
relay proxies `/api/projects`, `/api/projects/contexts`, and
`/api/settings/project-display-names` to the target VM and assembles
the result.

**Response:**
```json
{
  "roles": [
    {
      "project": "OCMarketplace",
      "displayName": "OC Market",
      "projectPath": "/home/readystack/projects/OCMarketplace",
      "roleFile": "developer.md",
      "roleName": "developer",
      "segment": "OCMarketplace-developer",
      "url": "/vm/readystack.dev-vm-01/OCMarketplace-developer/"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `project` | string | **Immutable project name** — directory basename, used in URLs and keys |
| `displayName` | string \| null | User-set label for the UI, or `null` (fall back to `project`) |
| `projectPath` | string | Absolute path on the VM |
| `roleFile` | string | Role filename (e.g., `developer.md`) |
| `roleName` | string | Display-friendly role name (filename without `.md`, dashes/underscores to spaces) |
| `segment` | string | URL segment: `{project}-{roleBase}` |
| `url` | string | Full relative URL to access this role in the browser |

> The `url` field uses the immutable `project` name, not the display
> name — URLs must remain stable even when display names change.

### Connector Management

#### `GET /api/__relay/self`

Returns the current connector's info (the VM the browser is connected to).

**Response:**
```json
{
  "id": "uuid",
  "name": "readystack.dev-vm-01",
  "displayName": "Dev VM 01",
  "customDisplayName": "My Dev Box",
  "role": "owner",
  "ownerLogin": "c0inz"
}
```

| Field | Description |
|-------|-------------|
| `name` | Immutable connector slug (used for URL routing) |
| `displayName` | Effective display name (`customDisplayName` if set, otherwise `name`) |
| `customDisplayName` | User-set tab title, or `null` |

#### `PUT /api/__relay/self/display-name`

Sets the browser tab title for this connector.

**Request body:**
```json
{ "displayName": "My Dev Box" }
```

Set to `null` or `""` to clear and revert to the default.
