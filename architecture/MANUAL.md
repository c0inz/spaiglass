# The `architecture.json` Manual — Mandatory Core

**Spec:** `spaiglass-architecture/1`
**Length:** ~5 pages — read end-to-end before writing a single field
**Companion:** [`MANUAL-REFERENCE.md`](./MANUAL-REFERENCE.md) — field reference, command cookbook, worked example (consult as needed)
**Published at:** `https://spaiglass.xyz/architecture-manual`

---

## Why this file exists

Every project gets one file: `architecture/architecture.json`. That file is the **operational snapshot** of what the project is doing right now — a human coming back after six months away should be able to open it and rebuild full mental context without touching the code.

The name is historical. A more honest name would be `running-architecture.json`. Treat it accordingly: you are documenting what is live, not what was planned. If the docs and the running system disagree, the manifest records the running system and opens a TODO against the docs. Never the reverse.

**Shallow architecture files are worse than no architecture file.** A breadcrumb diagram with five boxes and three arrows creates the illusion of documentation while hiding the risks it should be surfacing:

- A manifest with no site map won't help you find the 2024 signup form still live at `/old-signup`.
- A manifest with no database schema won't help you notice the tenant that stopped getting writes three weeks ago.
- A manifest with no unauthenticated-endpoint list can't be used as a security baseline.
- A manifest with no disk-usage breakdown won't tell you the uploads directory has been 90% full for a month.

This manual exists so that every `architecture.json` produced by a setup agent is a **real operational document**, not a breadcrumb.

---

## The eight non-negotiable rules

Internalize these before you write any field. Every rule has an enforcement check in [§Self-check](#self-check) at the end of this document.

### Rule 1 — This is a snapshot, not a design document

You are recording what the application is doing at the moment of generation. Not what it was planned to do. Not what it "should" be doing. Not what the README says it does. What it is doing *right now*, verified by observation.

### Rule 2 — Read this entire manual before writing any field

No skimming. The mandatory core is short by design — if it were shorter, the output would be shallow, and shallow is exactly what we're replacing. The reference appendix is longer and is meant to be consulted, not memorized.

### Rule 3 — Do not use application documentation as the source of truth

README, ARCHITECTURE.md, REQUIREMENTS.md, wikis, design docs, Notion pages, Confluence spaces — all of these drift. Some drift slowly, some drift in weeks. They are permitted as a **cross-check at the end** of the process, never as starting points.

The sources of truth are, in priority order:

1. The code as currently checked out (`git rev-parse HEAD` on the machine that will serve requests)
2. The processes that are actually running (`systemctl`, `pm2 jlist`, `ps`, `docker ps`)
3. The database as it currently exists (`information_schema`, `\d`, `SELECT count(*)`)
4. The URLs that actually respond (`curl -sSf`, `openssl s_client`)
5. The filesystem as it currently exists (`du`, `ls`, `find`)

If the code says one thing and the docs say another, the manifest records the code and you open a TODO against the docs.

### Rule 4 — Every `status` is measured, never declared

For every `status: "active"` or `status: "degraded"` or `status: "down"` in the file, you must record the command that was run and the timestamp of the observation. The field is `statusSource`, and it looks like this:

```json
{
  "status": "active",
  "statusSource": {
    "command": "systemctl is-active spaiglass.service",
    "output": "active",
    "observedAt": "2026-04-15T14:22:03Z"
  }
}
```

If you cannot verify status — the host is unreachable, the database rejects the connection, the systemd unit doesn't exist — write `"unknown"` and record *why* in `statusSource.error`. An honest unknown is correct when the ground truth can't be observed. Guessing is a failure.

### Rule 5 — List every route

Every screen, every page, every form, every API endpoint, every webhook. Pull the full route table from the router config — do not stop when the nav menu stops. A page reachable only by URL manipulation is exactly the kind of risk this manifest exists to surface.

For each route, record `incomingLinks`: every `href`, `<Link to>`, `navigate()`, and redirect in the codebase that points at this route. The derived field `orphan` is `incomingLinks.length === 0`. Orphans are listed in a dedicated `siteMap.orphans` array so a human scanning the manifest sees them immediately.

**Orphan pages are the signal, not the noise.** The 2024 signup form still mounted at `/old-signup` with no nav link is exactly why the site map is mandatory. If your manifest's orphan list is empty, verify it — empty is plausible, but "we just didn't check" produces the same empty list as "there really are none."

### Rule 6 — Descriptions explain purpose *and* failure mode

"What this does" is not enough. A description that reads `"Express API server, port 4201"` is a label, not a description. The useful form is:

> "SSR API server for the tenant-facing dashboard. Spawns on pm2 at port 4201. Handles auth, tenant provisioning, and Stripe webhook ingestion. If this is down, all customer-facing pages return 502 and Stripe webhook retries queue up — the retry window is 3 days before Stripe gives up, so a prolonged outage silently loses subscription events."

One line each, minimum. For every component: what it does, why it exists, what breaks when it's not there.

### Rule 7 — Redact secrets, preserve shapes

Never include credentials, keys, tokens, passwords, connection-string bodies, or API keys anywhere in the manifest. What you *do* include: the *fact that they exist*, where they're stored, and what format they take.

**Correct:**
```json
{
  "env": ["DATABASE_URL", "STRIPE_SECRET_KEY", "GITHUB_OAUTH_CLIENT_SECRET"],
  "secretsLocation": "/etc/spaiglass/.env (mode 600)",
  "secretsManager": "none — filesystem only"
}
```

**Wrong:**
```json
{
  "env": { "DATABASE_URL": "postgres://app:hunter2@..." }
}
```

For database connection strings, record the host, port, database name, and username — never the password. For cloud API keys, record that the key is set and where it's loaded from — never the key body. If you're about to paste a secret into the manifest, stop and replace it with a redaction sentinel.

### Rule 8 — Generate once end-to-end, then cross-check against docs

Order of operations:

1. Gather every field by observation of the live system (Rules 3–4).
2. Write the full manifest.
3. *Then* read the project's `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`, and any other docs.
4. For every contradiction you find, the manifest wins. Record the contradiction as a `docTodo` entry in the manifest's `details.history` block with `file`, `claim`, and `reality`.
5. Report the `docTodo` list back to the human so they can decide whether to fix the docs.

If you find yourself reading docs before running commands, you're doing it wrong. Start over.

---

## JSON schema at a glance

The full field reference is in [`MANUAL-REFERENCE.md`](./MANUAL-REFERENCE.md). The top-level shape:

```jsonc
{
  "spec": "spaiglass-architecture/1",
  "specUrl": "https://spaiglass.xyz/architecture-manual",
  "generatedAt": "2026-04-15T14:22:03Z",
  "generatedBy": "claude-opus-4-6 via setup agent",
  "generatorVersion": "1.0.0",

  // ─── Top-level (always present) ───
  "project":      { /* identity, owner, version, git, domain, overall status */ },
  "hosts":        [ /* every machine the app runs on */ ],
  "components":   [ /* every process/service, with purpose + failure mode */ ],
  "connections":  [ /* every dataflow between components and external services */ ],
  "siteMap":      { "kind": "web"|"cli"|"worker"|"none", /* ... */ },
  "datastores":   [ /* every persistent store this project owns */ ],

  // ─── Details (collapsed in the viewer, still mandatory) ───
  "details": {
    "disk":          { /* project footprint + upload/log/image dirs */ },
    "ci":            { /* workflows, last run, deploy strategy */ },
    "tests":         { /* framework counts, coverage, ci history */ },
    "security":      { /* public endpoints, exceptions, CVEs, threat model */ },
    "observability": { /* metrics, dashboards, SLOs, runbooks */ },
    "history":       { /* recent commits, releases, open PRs, docTodos */ },
    "dns":           { /* domains, cert expiry, CDN, WAF */ },
    "externalDeps":  [ /* stripe, resend, etc. — tier, cost, sdk version */ ]
  },

  // ─── Opt-in (only when explicitly requested) ───
  "business": { /* tenants, active users, MRR — omitted by default */ }
}
```

Top-level fields are always present. Fields inside `details` are always present but may be `null` with a reason when they don't apply (e.g. `"ci": null, "ciReason": "no .github/workflows directory"`). The `business` block is opt-in and must be omitted by default.

## The `siteMap.kind` sentinel

Not every project has a web surface. The manifest handles CLI tools, workers, and pure libraries with a `kind` sentinel that changes what populates the site map:

| `kind` | Populate with | Example |
|---|---|---|
| `"web"` | `routes[]`, `forms[]`, `orphans[]` | SpAIglass frontend, Express API |
| `"cli"` | `commands[]` (each with name, flags, subcommands, auth) | deploy scripts, admin CLIs |
| `"worker"` | `queuesConsumed[]`, `jobsRegistered[]`, `cronTriggers[]` | background job runners, pollers |
| `"none"` | site map is an empty object | pure libraries, SDKs |

Whichever kind applies, the mandatory fields inside the site map are still: every entry-point, every auth requirement, every external surface, and an `orphans` list (yes — CLI commands and worker jobs can be orphaned too — a registered handler with no caller in the repo is a signal worth surfacing).

## Shared datastores

A project scoped to one repo lists only the schemas that repo owns. When the Postgres (or Redis, or S3 bucket) is shared with other projects, mark the entry `"sharedInstance": true` and do not enumerate the neighbors' schemas. Record the instance location and your own schemas — nothing else.

## Sourcing philosophy — one example

To make the "observe, don't read docs" rule concrete, here is how the right sourcing for one field looks:

**Field:** `components[0].port` (the port the API server listens on)

**Wrong:** Read `README.md` and find the line "The API runs on port 4201."

**Right:**
```bash
# What's actually listening?
ss -tlnp | grep node
# tcp   LISTEN 0 511 0.0.0.0:4201  ... users:(("node",pid=1847,fd=21))

# Confirm the pid matches the pm2-managed API process
pm2 jlist | jq '.[] | select(.pid==1847)'
# { "name": "express-api", "pm2_env": { "status": "online", ... } }

# Cross-check against the config the process is reading
cat /etc/spaiglass/.env | grep PORT
# PORT=4201
```

The manifest records `port: 4201` with a `statusSource` referencing the `ss` command. If the config file said 4201 but `ss` showed nothing listening, the manifest would record `port: null, portStatus: "config says 4201 but nothing is listening"`. The observation wins.

Every field follows this shape. The command cookbook in the reference appendix has ~40 such recipes.

---

## Self-check — before declaring the manifest done

An agent must run every check on this list and attach the result as a `selfCheck` block at the end of the manifest. A manifest that fails any check is **not done**.

- [ ] `spec` is `"spaiglass-architecture/1"` and `specUrl` points at the manual
- [ ] `generatedAt` is within the current generation session
- [ ] Every component has a `status` with a `statusSource` command and timestamp
- [ ] Every component has a description that explains purpose AND failure mode (not just "does X")
- [ ] Every route in the router config appears in `siteMap.routes` (for `kind: "web"`)
- [ ] Every route has `incomingLinks` filled in (may be empty → orphan)
- [ ] `siteMap.orphans` matches the routes where `incomingLinks.length === 0`
- [ ] Every datastore has per-schema row counts and per-table sizes for the schemas this project owns
- [ ] Every datastore lists the DB users/roles that connect to it and their grants
- [ ] Disk usage is reported for the project root AND for any data roots outside it
- [ ] Upload/image/media directories are reported with total size AND file count
- [ ] `details.ci` last-run status is included (or `null` with a reason)
- [ ] `details.tests` counts are included by framework (unit / integration / e2e)
- [ ] `details.security.unauthenticatedEndpoints` is explicitly enumerated
- [ ] `details.security.exceptions` is present (may be empty — empty is a finding, not a pass)
- [ ] `details.history.docTodos` lists every contradiction found while cross-checking docs
- [ ] `business` block is present only if explicitly opted in
- [ ] No secrets, tokens, passwords, private keys, or connection-string bodies appear anywhere
- [ ] The top-level ASCII preview renders without truncation at 120 columns
- [ ] `selfCheck` block is present and every item above is `"passed"` or `"n/a"` with a reason

That's the core. Everything else — the full field reference, the command cookbook, the end-to-end worked example, the ASCII rendering conventions with every box-drawing character — lives in [`MANUAL-REFERENCE.md`](./MANUAL-REFERENCE.md). Consult it as you work. The core you just read is the part you commit to memory.

---

## Changelog

- **v1** (2026-04-15) — initial publication. Replaces the ad-hoc `architecture.json` shape previously produced without a written spec.
