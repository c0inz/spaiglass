# Maintainers

This file lists the people responsible for SpAIglass — who to ping for reviews, releases, and security/conduct reports.

## Primary maintainer

| Name | GitHub | Role | Contact |
|---|---|---|---|
| John Davenport | [@c0inz](https://github.com/c0inz) | Project lead, releases, infrastructure | hello@readystack.dev |

The primary maintainer is the default reviewer for pull requests, owns release tagging, and operates the live relay at `spaiglass.xyz`.

## Backup contact

If the primary maintainer is unreachable for more than two weeks (vacation, illness, etc.), the backup contact can:

- Acknowledge security reports sent to `security@readystack.dev`
- Triage urgent issues filed against the live relay
- Coordinate emergency releases for critical security fixes

| Name | Contact | Notes |
|---|---|---|
| Backup contact | jddavenpor46@gmail.com | Nominated 2026-04-10. Has read access to release infrastructure for emergency use only. |

## Areas

While this is a single-maintainer project today, the codebase has clear ownership boundaries. Pull requests touching these areas should be reviewed with the matching context in mind:

| Area | Path | Notes |
|---|---|---|
| Relay | `relay/` | Auth, WebSocket routing, connector registry, frontend serving |
| Host backend | `backend/` | Claude Code SDK integration, file API, session manager |
| Host connector | (in `backend/`) | Outbound WebSocket dialer, token handling |
| Frontend | `frontend/` | React app, terminal renderer, WS hook |
| Installers | `relay/release/install.sh`, `relay/release/install.ps1` | Per-user systemd / Windows service installers |
| Docs | `*.md`, `docs/` | README, ARCHITECTURE, ROADMAP, SECURITY, this file |

## Becoming a maintainer

We are not currently soliciting additional maintainers, but we are open to it. The path looks like:

1. Land several non-trivial PRs that show good judgment, careful testing, and clear communication.
2. Take on triage of incoming issues for an area you understand.
3. The primary maintainer proposes adding you and updates this file.

There is no formal governance model yet — when there are more than two maintainers, we will document one here.

## Reaching the team

| Channel | Use for |
|---|---|
| GitHub Issues | Bugs, feature requests, discussion |
| `security@readystack.dev` | Security vulnerabilities (see [SECURITY.md](SECURITY.md)) |
| `conduct@readystack.dev` | Code of conduct reports (see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)) |
| `hello@readystack.dev` | Anything else, or fallback if a specific mailbox is unreachable |
