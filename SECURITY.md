# Security Policy

SpAIglass routes browser sessions to user machines and handles authentication tokens, so we take security reports seriously. Thank you for taking the time to disclose responsibly.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Send a private report to:

> **security@readystack.dev**

If you prefer encrypted email, request our PGP key at the same address and we will reply with the public key out of band.

If you do not receive an acknowledgement within **3 business days**, please ping `hello@readystack.dev` as a fallback in case the security mailbox is unreachable.

### What to include

A good report makes it possible for us to reproduce the issue without back-and-forth. If you can, include:

- A clear description of the issue and the impact
- The component affected (`relay`, host `backend`, host `connector`, `frontend`, installer)
- The version, commit SHA, or release tag where you observed it
- Step-by-step reproduction instructions, ideally with a minimal proof-of-concept
- Your assessment of severity (informational, low, medium, high, critical) and why
- Whether the issue is already public anywhere
- How you would like to be credited (or "anonymous")

We will treat the report as confidential until a fix is published. We will never share your identity without your permission.

## Our response process

1. **Acknowledge** within 3 business days.
2. **Triage** within 7 business days — we tell you whether we accept the report, our severity assessment, and the fix owner.
3. **Fix** — we develop and test a patch on a private branch.
4. **Coordinate disclosure** — we agree on a public disclosure date with you. Default is **90 days from acknowledgement** or sooner if a fix ships earlier. Critical issues affecting the live relay get an emergency patch within 72 hours.
5. **Release** — we publish a patch release, push it to the live relay at `spaiglass.xyz`, and credit the reporter (if they consent) in the release notes and `CHANGELOG.md`.
6. **Public advisory** — we publish a GitHub Security Advisory with a CVE ID where appropriate.

## Supported versions

| Version | Supported |
|---|---|
| `main` (live relay at `spaiglass.xyz`) | Yes — security fixes applied immediately |
| Latest tagged release | Yes |
| Anything older than the latest tagged release | No — please upgrade |

The live relay is always running the latest tag or `main`. Self-hosters of the relay should track tagged releases and re-deploy when a security release is published.

## Scope

In scope for this policy:

- **Relay** (`relay/`) — including OAuth flow, session cookies, agent key API, WebSocket tunnel routing, rate limiting, the SQLite connector registry, and the static frontend served from `relay/dist/`
- **Host backend** (`backend/`) — file API path traversal, upload handling, session management, anything that could allow code execution outside the project directory
- **Host connector** — the outbound WebSocket dialer, token handling, reconnect logic
- **Installers** (`relay/release/install.sh`, `relay/release/install.ps1`) — anything that could escalate privileges, write outside the user's home directory, or persist after `--uninstall`
- **Frontend** (`frontend/`) — XSS, CSRF, prototype pollution, anything that could exfiltrate session cookies
- **The live deployment** at `spaiglass.xyz` — TLS configuration, exposed endpoints, response headers

Out of scope:

- Vulnerabilities in the upstream Anthropic Claude Code CLI itself — please report those to Anthropic
- Vulnerabilities in third-party dependencies, **unless** they are reachable through SpAIglass code paths and not already covered by a Dependabot PR
- Social engineering, physical attacks, or attacks on contributors' personal infrastructure
- Self-XSS that requires the victim to paste attacker-controlled JavaScript into their own browser
- Denial of service that requires more requests than our rate limits allow
- Findings from automated scanners without a working proof-of-concept
- Outdated software/library disclosures without a demonstrated impact

## Bug bounty

We do not currently offer a paid bug bounty. We will gladly credit reporters in release notes and the project's `SECURITY-HALL-OF-FAME.md` (created on first qualifying report).

## Hardening notes for self-hosters

If you run your own SpAIglass relay or expose a host backend on the open internet:

- Always front the relay with TLS (the bundled `Caddyfile` does this with Let's Encrypt)
- Keep the SQLite connector database (`relay/relay.db`) on encrypted storage
- Rotate the GitHub OAuth client secret if you suspect compromise
- Keep `node`, `npm`, and the Claude Code CLI up to date on host machines
- Never run the host backend as root — the installers default to per-user services for this reason
- Treat connector tokens as secrets equivalent to SSH keys

Thank you for helping keep SpAIglass and its users safe.
