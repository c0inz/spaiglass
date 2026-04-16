# The `architecture.json` Manual — Reference Appendix

**Spec:** `spaiglass-architecture/1`
**Length:** ~10 pages — reference, not mandatory read
**Core:** [`MANUAL.md`](./MANUAL.md) — read end-to-end first
**Published at:** `https://spaiglass.xyz/architecture-manual#reference`

This file is the working bench. The core manual tells you *why* and *what*; this file tells you *exactly which field names, which commands, and which shapes*. Consult it as you work. Do not try to memorize it.

Structure:

1. [Field reference](#1-field-reference) — every field in the schema, its type, whether it's required, and its sourcing rule
2. [Command cookbook](#2-command-cookbook) — the exact commands an agent runs to populate each category
3. [ASCII rendering conventions](#3-ascii-rendering-conventions) — box characters, arrows, trees, status dots, tables
4. [Worked example](#4-worked-example) — one component populated end-to-end: observation → JSON → ASCII
5. [Failure modes and their honest answers](#5-failure-modes)

---

## 1. Field reference

### 1.1 `project` — application identity

```jsonc
"project": {
  "name":        "string, canonical product name",
  "slug":        "string, URL/DNS-safe short name",
  "version":     "string, currently-deployed version",
  "git": {
    "commit":    "string, full SHA deployed",
    "branch":    "string",
    "remote":    "string, https or ssh URL",
    "signedBy":  "string|null, signing key fingerprint from git log -1 --format='%G? %GS'",
    "dirty":     "boolean, true if uncommitted changes on the deploy host"
  },
  "owner":       "string, primary human owner",
  "maintainers": ["string, current active maintainers from MAINTAINERS.md or recent committers"],
  "licenseId":   "string, SPDX identifier from LICENSE file",
  "createdAt":   "ISO8601, from `git log --reverse --format=%aI | head -1`",
  "lastDeployAt":"ISO8601, from systemd ActiveEnterTimestamp or CI artifact",
  "lastDeployBy":"string, from CI run metadata or deploy log",
  "domain":      "string, primary public domain if any",
  "status":      "one of: ok, degraded, down, unknown (aggregated — see Rule 4 in core)",
  "statusSource":{ "command": "...", "observedAt": "..." }
}
```

### 1.2 `hosts[]` — every machine the app runs on

```jsonc
{
  "id":          "string, stable machine identifier",
  "name":        "string, human label",
  "provider":    "string, e.g. digitalocean, aws, hetzner, on-prem, local-vm",
  "providerId":  "string, droplet ID or instance ID if applicable",
  "providerName":"string, the exact resource name in the provider dashboard",
  "publicIp":    "string|null",
  "privateIp":   "string|null",
  "tailscaleIp": "string|null",
  "os":          "string, from /etc/os-release",
  "kernel":      "string, from uname -r",
  "cpuCores":    "number, from nproc",
  "ramGb":       "number, from free -g",
  "diskTotalGb": "number, from df -h /",
  "diskUsedGb":  "number",
  "diskFreeGb":  "number",
  "projectDiskUsageMb": "number, du -sh of this project's root (record the exact path used)",
  "uptime":      "string, from uptime -p",
  "lastReboot":  "ISO8601, from who -b",
  "timezone":    "string, from timedatectl",
  "region":      "string, provider region",
  "monthlyCostUsd": "number|null, from provider billing if known",
  "openPorts":   [{ "port": 443, "proto": "tcp", "process": "caddy" }],
  "sshAccess":   ["string, users or keys with SSH access"],
  "backupPolicy":"string, e.g. 'DO snapshots weekly' or 'none'",
  "status":      "ok|degraded|down|unknown",
  "statusSource":{ "command": "ssh <host> uptime", "observedAt": "..." }
}
```

### 1.3 `components[]` — runtime processes and services

```jsonc
{
  "id":          "string",
  "name":        "string, human label",
  "type":        "api-server|worker|spa|gateway|cli|cron|db|cache|queue-consumer|static-site|lambda|mcp-tool",
  "description": "string, MUST explain purpose AND failure mode (see Rule 6)",
  "runsOn":      ["host id"],
  "processName": "string, from systemctl or ps",
  "systemdUnit": "string|null",
  "pm2Id":       "number|null",
  "pid":         "number|null",
  "command":     "string, entrypoint as actually running",
  "workingDir":  "string",
  "env":         ["string, env var names only — NEVER values"],
  "port":        "number|null",
  "bindAddress": "string, e.g. 127.0.0.1 or 0.0.0.0",
  "language":    "string",
  "runtime":     "string, e.g. node",
  "runtimeVersion":"string, e.g. v22.4.0",
  "codePath":    "string, source directory on the host",
  "startedAt":   "ISO8601",
  "restartCount":"number",
  "memoryRssMb": "number",
  "cpuPct":      "number",
  "logPath":     "string",
  "dependsOn":   ["component id or external service"],
  "purpose":     "string, why this component exists",
  "expectedLoad":"string, e.g. '200 req/min avg, 800 peak'",
  "provenLoad":  "string, observed last 7 days — include source",
  "status":      "ok|degraded|down|unknown",
  "statusSource":{ "command": "...", "output": "...", "observedAt": "..." }
}
```

### 1.4 `connections[]` — dataflows

```jsonc
{
  "id":        "string",
  "from":      "component or host id",
  "to":        "component or external service name",
  "mode":      "https|wss|grpc|stdio|ipc|sql|redis-proto|sqs|kafka|webhook|http",
  "direction": "unidirectional|bidirectional",
  "purpose":   "string, one line describing what flows",
  "payload":   "string, shape of the data (json, ndjson, binary, sql, protobuf)",
  "auth":      "bearer|mtls|oauth|basic|none|webhook-signature",
  "encryption":"string, e.g. 'TLS 1.3' or 'none (loopback)'",
  "port":      "number|null",
  "path":      "string|null, URL path or SQL schema",
  "rateLimit": "string|null",
  "expectedVolumePerDay": "string|null",
  "retryPolicy":"string|null",
  "failureMode":"string, what breaks when this edge goes down",
  "timeoutMs":  "number|null",
  "latencyP50Ms":"number|null, measured",
  "latencyP95Ms":"number|null, measured"
}
```

### 1.5 `siteMap` — routes, forms, orphans (web / cli / worker / none)

```jsonc
"siteMap": {
  "kind": "web|cli|worker|none",

  // kind: "web"
  "routes": [{
    "path":        "string, URL pattern e.g. /users/:id/edit",
    "method":      ["GET","POST"],
    "component":   "string, file:exportName",
    "title":       "string|null, from <title> or page header",
    "description": "string, what a user does here",
    "kind":        "page|form|api|redirect|asset|webhook",
    "auth":        "public|user|admin|role:<name>|webhook-signature",
    "role":        ["string"],
    "incomingLinks": [{ "from": "/dashboard", "kind": "nav-link" }],
    "orphan":      "boolean, derived (incomingLinks empty)",
    "reachableByUrlOnly": "boolean, derived",
    "formFields":  [{ "name": "email", "type": "email", "required": true }],
    "submitEndpoint": "string|null",
    "parent":      "string|null, parent path",
    "children":    ["string"],
    "lastModified":"ISO8601, git log -1 --format=%aI <file>",
    "hits7d":      "number|null, from access logs",
    "status":      "live|stub|deprecated|hidden|broken",
    "featureFlag": "string|null"
  }],
  "orphans": [ "same shape as routes" ],
  "forms":   [ "derived convenience view" ],
  "publicRoutes":  ["string, path list of auth=public routes"],
  "adminRoutes":   ["string, path list of auth=admin or role=admin"],

  // kind: "cli"
  "commands": [{
    "name":        "string",
    "subcommands": ["string"],
    "flags":       [{ "name": "--verbose", "type": "boolean" }],
    "description": "string",
    "auth":        "string",
    "orphan":      "boolean, registered but never invoked in-repo",
    "definedIn":   "string, file:exportName"
  }],

  // kind: "worker"
  "queuesConsumed": [{ "queue": "string", "handler": "file:exportName", "description": "string" }],
  "jobsRegistered": [{ "name": "string", "schedule": "string", "handler": "file:exportName" }],
  "cronTriggers":   [{ "schedule": "string", "command": "string" }]

  // kind: "none"  — siteMap is an empty object other than `kind`
}
```

### 1.6 `datastores[]` — persistent stores this project owns

```jsonc
{
  "id":          "string",
  "name":        "string",
  "engine":      "postgres|mysql|sqlite|redis|mongo|s3|minio|elasticsearch|filesystem",
  "engineVersion": "string, from SELECT version() or equivalent",
  "host":        "string",
  "port":        "number",
  "runsOn":      "host id",
  "sharedInstance": "boolean, true if engine hosts schemas for other projects",
  "connectionShape": "string, e.g. 'postgres://<user>@<host>:5432/<db>' — NEVER include the password",
  "sizeOnDiskGb":"number",
  "backupPolicy":"string",
  "backupLastRunAt":"ISO8601|null",
  "usedBy":      ["component id"],

  "schemas": [{
    "name":      "string",
    "purpose":   "string, why this schema exists",
    "ownerRole": "string, DB role",
    "tables":    [{
      "name":        "string",
      "purpose":     "string",
      "columns":     [{ "name": "email", "type": "text", "nullable": false, "default": null, "fk": null }],
      "primaryKey":  ["column name"],
      "foreignKeys": [{ "columns": ["user_id"], "references": "users.id" }],
      "indexes":     ["string, index name"],
      "rowCountApprox":"number, from pg_class.reltuples or equivalent",
      "sizeMb":      "number, from pg_total_relation_size",
      "writtenTo":   ["component id"],
      "readFrom":    ["component id"],
      "hasPii":      "boolean"
    }]
  }],

  "roles": [{
    "name":    "string, DB role",
    "usedBy":  "component id",
    "grants":  ["string, e.g. 'SELECT,INSERT on schema_hub.*'"],
    "canLogin":"boolean",
    "superuser":"boolean"
  }],

  "extensions":   ["string, e.g. pg_stat_statements"],
  "migrationsApplied": "number",
  "migrationsPending": "number",
  "replicationTopology": "string|null"
}
```

### 1.7 `details.disk` — filesystem footprint

```jsonc
"disk": {
  "projectRoot":       "string, absolute path",
  "projectRootSizeMb": "number, du -sh of that path",
  "topLevelDirs": [{
    "path":        "string, relative to project root",
    "purpose":     "string, what lives here and why",
    "sizeMb":      "number",
    "fileCount":   "number",
    "owner":       "string",
    "mode":        "string, e.g. drwxr-xr-x",
    "isGenerated": "boolean, can be regenerated from source?",
    "backedUp":    "boolean"
  }],
  "dataRoots": [{
    "path":        "string, absolute path (outside project root)",
    "purpose":     "string",
    "sizeMb":      "number",
    "fileCount":   "number",
    "kind":        "uploads|logs|cache|secrets|db-volume|build-artifacts"
  }],
  "uploadsTotalMb":    "number",
  "uploadsFileCount":  "number",
  "uploadsOldestFile": "ISO8601|null",
  "logsTotalMb":       "number",
  "buildArtifactsMb":  "number",
  "projectTotalOnHostMb": "number, sum of project root + data roots"
}
```

### 1.8 `details.ci` — CI/CD pipeline

```jsonc
"ci": {
  "provider":         "github-actions|gitlab-ci|circleci|jenkins|none",
  "workflowFiles":    ["string, e.g. .github/workflows/ci.yml"],
  "workflows": [{
    "name":       "string",
    "file":       "string",
    "triggers":   ["push:main","pull_request","schedule:0 3 * * *"],
    "jobs":       ["string, job name"],
    "lastRunAt":  "ISO8601",
    "lastRunResult":"success|failure|cancelled",
    "avgDurationSec": "number"
  }],
  "deployStrategy":      "rolling|blue-green|atomic-rsync|serverless|none",
  "deployTargets":       ["string"],
  "secretsUsed":         ["string, secret NAMES only"],
  "lastSuccessfulRunAt": "ISO8601",
  "lastFailedRunAt":     "ISO8601|null",
  "requiredChecksOnMain":["string, check names from branch protection"],
  "signedCommitsRequired": "boolean",
  "releaseArtifactVerification": "string|none, e.g. 'sigstore attestation'"
}
```

### 1.9 `details.tests` — test surface

```jsonc
"tests": {
  "frameworks":       ["string, e.g. vitest, playwright, pytest"],
  "unitCount":        "number",
  "integrationCount": "number",
  "e2eCount":         "number",
  "contractCount":    "number",
  "coveragePct":      "number|null",
  "testingMethods":   ["real-db-integration","mocked-integration","snapshot","property","fuzz","contract"],
  "testingGaps":      ["string, known-unrepresented areas"],
  "lastLocalRunAt":   "ISO8601|null",
  "lastCiRunAt":      "ISO8601",
  "lastCiRunResult":  "pass|fail",
  "recentCiTrend":    ["pass","pass","fail","pass","pass","pass","pass","pass","pass","pass"],
  "flakyTests":       ["string, test name"],
  "manualQaChecklistPath": "string|null"
}
```

### 1.10 `details.security` — exposure and provisions

```jsonc
"security": {
  "publicEndpoints":           ["string, URL path"],
  "unauthenticatedEndpoints":  ["string, URL path — explicitly enumerated"],
  "adminEndpoints":            ["string, URL path"],
  "tlsVersion":                "string",
  "hstsEnabled":               "boolean",
  "hstsMaxAge":                "number|null",
  "cspPolicy":                 "string|null, the full CSP header value",
  "sriEnabled":                "boolean",
  "cookies": [{ "name":"session", "secure":true, "httpOnly":true, "sameSite":"Lax" }],
  "authProviders":             ["string, e.g. github-oauth, password, magic-link"],
  "mfaRequired":               "boolean",
  "sessionStore":              "string, e.g. 'sqlite @ /opt/app/sessions.db'",
  "rateLimits":                [{ "endpoint":"/api/auth/login", "policy":"5/min" }],
  "webhookSignatureVerification": [{ "endpoint":"/api/webhooks/stripe", "verified":true }],
  "secretsLocation":           "string, e.g. '/etc/app/.env mode 600'",
  "secretsManager":            "string, e.g. 'filesystem only' or 'aws-secrets-manager'",
  "openCves":                  [{ "package":"lodash", "version":"4.17.20", "cve":"CVE-2021-23337", "severity":"high" }],
  "dependabotOpen":            "number",
  "exceptions": [{
    "id":        "string",
    "what":      "string, the exception",
    "why":       "string, the rationale",
    "introducedAt": "ISO8601",
    "expiresAt": "ISO8601|null",
    "owner":     "string"
  }],
  "dataResidency":  "string, e.g. 'us-east-1 only'",
  "piiLocations":   ["string, datastore.schema.table"],
  "encryptionAtRest":[{ "datastore":"id", "method":"LUKS|provider-default|none" }],
  "incidentLog":    [{ "date":"ISO8601", "summary":"string", "rcaLink":"string|null" }],
  "lastPentestAt":  "ISO8601|null",
  "threatModel":    "string, one-paragraph"
}
```

### 1.11 `details.observability`, `details.history`, `details.dns`, `details.externalDeps`

Shapes are analogous — see Part 1 of the workplan for the field list. The reference will be expanded as we finalize spec v1.

### 1.12 `business` — opt-in only

Present **only** when the project's CLAUDE.md or the human explicitly asks for it. Default manifests must omit this key entirely.

```jsonc
"business": {
  "tenantCount":      "number, SELECT count(*) FROM tenants",
  "activeUsers7d":    "number",
  "activeUsers30d":   "number",
  "newSignups30d":    "number",
  "mrrUsd":           "number|null",
  "churn30d":         "number|null",
  "supportTicketsOpen": "number|null",
  "customersByPlan": [{ "plan":"pro", "count":42 }],
  "featureFlags":    [{ "name":"new-onboarding", "enabled":true, "rolloutPct":100 }]
}
```

---

## 2. Command cookbook

Every command below is a recipe for populating one category. The agent runs the command, parses the output, and fills the corresponding fields.

### 2.1 Project identity

```bash
# Version
cat VERSION 2>/dev/null || jq -r .version package.json

# Git
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git remote get-url origin
git log -1 --format='%G? %GS'
git status --porcelain | wc -l    # dirty if >0
git log --reverse --format=%aI | head -1    # createdAt
```

### 2.2 Hosts

```bash
# Identity
cat /etc/os-release
uname -r
nproc
free -g | awk '/Mem:/ {print $2}'
df -h / | awk 'NR==2 {print $2, $3, $4}'
uptime -p
who -b
timedatectl | grep "Time zone"

# Project disk usage
du -sh "$PROJECT_ROOT" 2>/dev/null
du -sh "$PROJECT_ROOT"/* 2>/dev/null   # top-level breakdown

# Upload/log/image directories
du -sh "$UPLOADS_DIR" 2>/dev/null
find "$UPLOADS_DIR" -type f | wc -l
du -sh /var/log/"$PROJECT" 2>/dev/null

# Open ports
ss -tlnp

# Provider-specific (DigitalOcean example via doctl)
doctl compute droplet list --format ID,Name,PublicIPv4,Region,Memory,VCPUs,Disk,Status
```

### 2.3 Components

```bash
# Systemd services
systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1}'
systemctl show -p MainPID,ActiveState,MemoryCurrent,NRestarts,ActiveEnterTimestamp <unit>
systemctl cat <unit>    # read the unit file for ExecStart, WorkingDirectory, Environment

# pm2-managed processes
pm2 jlist | jq -r '.[] | {name, pid, status: .pm2_env.status, restart: .pm2_env.restart_time, uptime: .pm2_env.pm_uptime, cwd: .pm2_env.pm_cwd, script: .pm2_env.pm_exec_path}'

# Raw processes
ps -eo pid,ppid,user,rss,%cpu,cmd --sort=-rss | head -20

# Port → process
ss -tlnp | awk '/LISTEN/ {print $4, $6}'

# Runtime versions
node --version 2>/dev/null
python3 --version 2>/dev/null
```

### 2.4 Site map — web kind

```bash
# Starting points (adapt to framework)
grep -rn "createBrowserRouter\|<Routes>\|app.get\|app.post\|router\\..*(" src/ backend/ 2>/dev/null

# Every <Link to=...>, navigate(...), or href=/...
grep -rn --include='*.tsx' --include='*.ts' --include='*.jsx' --include='*.js' \
  -E "<Link to=|navigate\(|href=\"/" src/

# For Express/Hono: list the registered routes at runtime by printing them on startup
# or inspect the router tree via app._router.stack
```

For each route found, match it against the incoming-links list to compute `orphan`.

### 2.5 Site map — cli kind

```bash
# If the CLI uses Commander / yargs / Click / Cobra, find the command registrations
grep -rn "\.command(\|@click.command\|cobra.Command" src/

# If it's a handful of bash scripts, enumerate them
find bin/ scripts/ -maxdepth 2 -type f -perm -u+x
```

### 2.6 Datastores — Postgres

```sql
-- Engine version
SELECT version();

-- Schemas this role can see (filter to schemas this project owns)
SELECT nspname FROM pg_namespace
WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema';

-- Per-schema table list with row estimates and sizes
SELECT
  n.nspname AS schema,
  c.relname AS table,
  c.reltuples::bigint AS rows_approx,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = ANY($owned_schemas)
ORDER BY pg_total_relation_size(c.oid) DESC;

-- Columns for one table
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = $schema AND table_name = $table
ORDER BY ordinal_position;

-- Foreign keys
SELECT tc.constraint_name, kcu.column_name,
       ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
JOIN information_schema.constraint_column_usage ccu USING (constraint_name, table_schema)
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $schema AND tc.table_name = $table;

-- Roles and their grants
SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname NOT LIKE 'pg_%';
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = ANY($owned_schemas)
ORDER BY grantee, table_schema, table_name;

-- Database size
SELECT pg_size_pretty(pg_database_size(current_database()));
```

### 2.7 CI / GitHub Actions

```bash
gh run list --limit 10 --json status,conclusion,createdAt,headBranch,workflowName,databaseId
gh api "repos/$OWNER/$REPO/branches/main/protection" \
  | jq '{required: .required_status_checks.contexts, signedCommits: .required_signatures.enabled}'
gh api "repos/$OWNER/$REPO/actions/workflows" | jq '.workflows[] | {name, path, state}'
```

### 2.8 Tests

```bash
# Vitest
cd frontend && npx vitest list 2>/dev/null | wc -l

# Playwright
cd frontend && npx playwright test --list 2>/dev/null | grep -c '› '

# Pytest
cd . && python -m pytest --collect-only -q 2>/dev/null | tail -3

# Coverage (if cached)
jq -r '.total.lines.pct' coverage/coverage-summary.json 2>/dev/null
```

### 2.9 Security

```bash
# TLS
echo | openssl s_client -servername $DOMAIN -connect $DOMAIN:443 2>/dev/null \
  | openssl x509 -noout -dates -issuer -subject

# Response headers
curl -sI https://$DOMAIN/ | grep -iE 'strict-transport|content-security|x-frame|x-content-type'

# Dependency CVEs
npm audit --json 2>/dev/null | jq '.metadata.vulnerabilities'
pip-audit -f json 2>/dev/null | jq 'length'

# Open Dependabot alerts
gh api "repos/$OWNER/$REPO/dependabot/alerts?state=open" | jq 'length'
```

### 2.10 DNS

```bash
dig +short $DOMAIN
dig ANY $DOMAIN
curl -sIL https://$DOMAIN/ | grep -i 'server:\|cf-ray:'    # CDN/WAF detection
```

---

## 3. ASCII rendering conventions

The viewer and the generated ASCII previews share these conventions so a human can sketch one on paper and recognize what the viewer renders.

### 3.1 Boxes

```
┌──────────┐
│  label   │
└──────────┘
```

Use single-line box characters. No double lines except for major section headers (§3.5).

### 3.2 Status dots

Exactly one character plus the word. Color is applied by the viewer; the character alone must be unambiguous in monochrome.

```
● active
◐ degraded
○ down
? unknown
```

### 3.3 Connectors — data direction is mandatory

```
a ──▶ b      a writes to b
a ◀── b      a reads from b
a ◀─▶ b      bidirectional
a ━━▶ b      bold — critical dependency (outage breaks a)
a ╌╌▶ b      dashed — optional dependency (degraded ok)
```

### 3.4 Tree indent (site map, schema list)

```
/
├── dashboard
│   ├── users
│   └── settings
├── api
│   └── auth
│       └── login
└── (orphans)
    ├── old-signup ⚠
    └── debug/tenant/:id ⚠
```

The `⚠` marker is **reserved for orphaned and security-relevant items**. Do not use it inline mid-sentence or as general "warning" decoration. It must be greppable: `grep ⚠ architecture.json` returns exactly the list of flagged items.

### 3.5 Section headers — double bar

```
══ COMPONENTS ══════════════════════════════════════
```

Used only for top-level sections (HOSTS, COMPONENTS, CONNECTIONS, SITE MAP, DATASTORES, DETAILS).

### 3.6 Tables — single-line pipes, right-aligned numerics

```
│ host          │ provider │ cpu │    ram │   disk │ status │
│ solarwebsites │ DO       │   4 │  16 GB │  80 GB │   ●    │
│ grandgallery  │ DO       │   2 │   4 GB │ 160 GB │   ●    │
```

### 3.7 Full top-of-file preview (the "above the fold")

The viewer renders this at the top of the page regardless of manifest size:

```
┌──────────────────────────────────────────────────────────────────────┐
│ <name> — v<version> — <repo URL>                                     │
│ Status: <dot>  Generated: <ISO timestamp>                            │
│ Owner: <owner>  Domain: <domain>                                     │
└──────────────────────────────────────────────────────────────────────┘

══ HOSTS ═══════════════════════════════════════════════════════════════
  <name>  <provider>  <ip>  <status>  <os>
    <ram> RAM · <disk> disk (<used>%) · project: <proj_mb> · uploads: <up_mb>
  …

══ COMPONENTS ══════════════════════════════════════════════════════════
  ┌─ <name> ──────────────┐
  │ <type>, <port>, <mgr> │ ──▶ <dep1>
  │ <load avg> · <mem>    │ ──▶ <dep2>
  │ "<purpose one-liner>" │
  └───────────────────────┘

══ SITE MAP ════════════════════════════════════════════════════════════
  <n> routes · <o> orphaned · <p> public · <a> auth-gated · <adm> admin
  <tree>
  ORPHANED:
    <orphan list with ⚠>

══ DATASTORES ══════════════════════════════════════════════════════════
  <engine> @ <host>:<port> (<version>) · <size> · backup <when>
    <schema>  <purpose> · <table count> tables · <row count> rows [<pii flag>]

▼ Details (CI · tests · security · observability · history · dns · deps)
```

---

## 4. Worked example

One component, end-to-end, so the mapping from observation → JSON → ASCII is concrete. Using the EPC Express API as the subject because it's the example John screenshotted.

### 4.1 Observations

```bash
$ ssh solarwebsites systemctl list-units --type=service --state=running | grep -i epc
  (nothing — this project runs under pm2, not systemd)

$ ssh solarwebsites pm2 jlist | jq '.[] | select(.name=="express-api")'
{
  "name": "express-api",
  "pid": 1847,
  "pm2_env": {
    "status": "online",
    "pm_cwd": "/opt/epc/backend",
    "pm_exec_path": "/opt/epc/backend/dist/server.js",
    "restart_time": 3,
    "pm_uptime": 1734201223000,
    "version": "2026.04.10"
  },
  "monit": { "memory": 146800640, "cpu": 2.1 }
}

$ ssh solarwebsites ss -tlnp | grep 4201
LISTEN 0 511 0.0.0.0:4201 *:* users:(("node",pid=1847,fd=21))

$ ssh solarwebsites 'cat /opt/epc/backend/.env | awk -F= "{print \$1}"'
NODE_ENV
PORT
DATABASE_URL
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
RESEND_API_KEY
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET

$ ssh solarwebsites 'cd /opt/epc && git rev-parse HEAD'
1c4e7a9b3d...

$ ssh solarwebsites 'cd /opt/epc && git log -1 --format="%G? %GS"'
G John Davenport
```

### 4.2 JSON entry

```json
{
  "id": "express-api",
  "name": "Express API",
  "type": "api-server",
  "description": "SSR API server for the EPC tenant-facing dashboard. Spawned by pm2 on port 4201. Handles auth, tenant provisioning, Stripe webhook ingestion, and Resend transactional email sends. If this is down, all customer-facing pages return 502 and Stripe webhook retries queue up — Stripe's retry window is 3 days, so a prolonged outage silently loses subscription events.",
  "runsOn": ["solarwebsites"],
  "processName": "node",
  "pm2Id": 0,
  "pid": 1847,
  "command": "node /opt/epc/backend/dist/server.js",
  "workingDir": "/opt/epc/backend",
  "env": [
    "NODE_ENV", "PORT", "DATABASE_URL",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"
  ],
  "port": 4201,
  "bindAddress": "0.0.0.0",
  "language": "TypeScript",
  "runtime": "node",
  "runtimeVersion": "v22.4.0",
  "codePath": "/opt/epc/backend",
  "startedAt": "2026-04-14T18:33:43Z",
  "restartCount": 3,
  "memoryRssMb": 140,
  "cpuPct": 2.1,
  "logPath": "/home/readystack/.pm2/logs/express-api-out.log",
  "dependsOn": ["postgres", "file-storage", "stripe", "resend"],
  "purpose": "Single entrypoint for all EPC tenant-facing HTTP traffic; SSR for initial page loads, JSON API for subsequent interactions.",
  "expectedLoad": "200 req/min avg, 800 peak — based on nginx access logs",
  "provenLoad": "238 req/min avg over last 7 days (source: nginx access log sampling via goaccess)",
  "status": "active",
  "statusSource": {
    "command": "pm2 jlist | jq '.[] | select(.name==\"express-api\") | .pm2_env.status'",
    "output": "online",
    "observedAt": "2026-04-15T14:22:03Z"
  }
}
```

### 4.3 ASCII fragment the viewer renders

```
  ┌─ express-api ────────────────────────┐
  │ api-server, :4201, pm2, ● active     │ ──▶ postgres   (hub + AIEPC_* schemas)
  │ 238 req/min · 140 MB RSS · 3 restarts│ ──▶ file-storage (HTTP :8090)
  │ "SSR, auth, tenant provisioning"     │ ──▶ stripe     (outbound + webhooks)
  │                                      │ ──▶ resend     (transactional email)
  └──────────────────────────────────────┘
```

Compare to the original thin output (`Express.js API + SSR service ● active`). The difference is the difference this manual exists to enforce.

---

## 5. Failure modes

An agent will hit cases where observation is impossible. Honest answers for each:

| Situation | Honest answer |
|---|---|
| Host unreachable via SSH | `"status": "unknown"`, `statusSource.error: "ssh connect timeout after 10s"` |
| Systemd unit name unknown | Scan `systemctl list-units --type=service` for matching names, list candidates in `statusSource.candidates`. Don't guess. |
| Database refuses connection | Record `sizeOnDiskGb: null`, `schemas: []`, `dataLayerStatus: "unreachable — credentials rejected"`. Do not fake schema data. |
| CI history inaccessible | `"ci": null`, `"ciReason": "gh api returned 404 — fine-grained PAT lacks Actions:Read on this repo"` |
| Uploads directory doesn't exist at the expected path | Search: `find / -type d -name uploads -not -path '/proc/*' 2>/dev/null`. Record what you found OR record `uploadsPath: null` with the search command in the statusSource. |
| Router config is split across N files and you can't grep them all | Record the routes you found, set `siteMap.completeness: "partial"`, list the files you searched in `siteMap.searchedFiles`, and surface the gap in `selfCheck`. |
| Test count is zero | `unitCount: 0` is a legitimate finding. Do not pretend. Flag it in `testingGaps: ["no unit tests present"]`. |
| The project turns out to have no web surface at all | `"siteMap": { "kind": "none" }` — not an empty `"web"`. Picking the right `kind` matters. |

**The guiding principle: an honest "unknown with reason" is always better than a plausible-sounding guess.** Future agents reading this manifest will trust the file, and a wrong confident field is a worse failure than a missing one.

---

## Changelog

- **v1** (2026-04-15) — initial publication.
