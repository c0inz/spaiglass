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

| Version                                       | Supported                                |
| --------------------------------------------- | ---------------------------------------- |
| `main` (live relay at `spaiglass.xyz`)        | Yes — security fixes applied immediately |
| Latest tagged release                         | Yes                                      |
| Anything older than the latest tagged release | No — please upgrade                      |

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

## Trust assumption: the relay originates the frontend bundle

There is one trust assumption in the SpAIglass model that needs to be stated explicitly, and which the README also documents:

**Using the hosted relay at `spaiglass.xyz` means trusting ReadyStack.dev to serve a legitimate frontend bundle.** The relay's WebSocket forwarding is opaque (we never inspect the frames), but the relay also _originates_ the JavaScript that runs in your browser. A compromised relay does not need to inspect WebSocket frames to read your input — it could serve a tampered bundle that captures keystrokes before they ever become a frame.

Browser-side defenses such as Content-Security-Policy (CSP) and Subresource Integrity (SRI) raise the cost of _other_ attack classes (XSS, MITM, third-party CDN compromise) but **do not stop a compromised origin** from serving its own malicious JavaScript with a matching CSP nonce and matching SRI hash. Both CSP and SRI are still worth shipping — they reduce the attack surface meaningfully — but neither replaces the trust assumption.

### What specifically could a compromised relay do?

To be explicit about the threat:

- **Read everything you type** — the JavaScript in your browser captures keystrokes before they become WebSocket frames. A tampered bundle could silently exfiltrate chat input, API keys pasted into settings, or file contents opened in the editor.
- **Read everything Claude returns** — the bundle renders Claude's responses. A tampered version could copy them elsewhere.
- **Modify Claude's responses** — the bundle could alter what you see without changing what the VM actually received.
- **Serve a different bundle to different users** — a targeted attack could serve the legitimate bundle to most users and a tampered one to a specific GitHub login.

None of these require the relay to touch WebSocket frames at the routing layer. The attack surface is the frontend origin, not the tunnel.

### What a compromised relay CANNOT do

- **Access your VM filesystem directly** — the relay has no shell access, no SSH key, no file API. It can only forward what the browser sends through the WebSocket.
- **Use your Anthropic API key** — the key is stored on the VM in `.env` (mode 600). The relay never sees it. A tampered frontend _could_ read it from the Settings UI if you open that page, but the key is not transmitted through the relay during normal chat.
- **Persist after you stop using it** — there is no service worker or local storage mechanism that survives closing the tab. If you switch to a self-hosted relay or stop using SpAIglass, the compromised code stops running.

### Recommended mitigations, in order of strength

1. **Self-host the relay.** This is the strongest defense and the one we explicitly recommend for users whose threat model can't accept third-party origin trust. The relay is ~800 lines of TypeScript in `relay/src/`, MIT licensed, and the README has the deployment instructions. Your trust boundary becomes "do I trust myself to operate this droplet."

2. **Independent bundle verification of the live relay.** The live relay's `/api/health` endpoint reports `{"commit": "<git_sha>", "frontend_sha256": "<bundle hash>"}`. Each GitHub release records the frontend bundle hash in its release notes, and release artifacts are signed with Sigstore attestation. Anyone can verify:

   **Quick check (no tools required):**

   ```bash
   curl -s https://spaiglass.xyz/api/health | grep -E '"commit"|"frontend_sha256"'
   ```

   Compare the `commit` value against [github.com/c0inz/spaiglass/commits](https://github.com/c0inz/spaiglass/commits/main). If the commit doesn't exist in the public repo, stop using the relay.

   **Full verification (requires [gh CLI](https://cli.github.com/)):**

   ```bash
   # 1. Get the live relay's self-reported commit and bundle hash
   curl -s https://spaiglass.xyz/api/health | jq '{commit, frontend_sha256}'

   # 2. Find the release for that commit and compare hashes
   gh release list --repo c0inz/spaiglass --limit 5
   gh release view <tag> --repo c0inz/spaiglass --json body --jq .body | grep frontend_sha256

   # 3. Verify Sigstore attestation on release artifacts
   gh release download <tag> --repo c0inz/spaiglass --pattern 'spaiglass-host-linux-x64.tar.gz'
   gh attestation verify spaiglass-host-linux-x64.tar.gz --repo c0inz/spaiglass
   ```

   **Automated verification script:**

   ```bash
   curl -fsSL https://raw.githubusercontent.com/c0inz/spaiglass/main/verify.sh | bash
   ```

   The script queries `/api/health`, checks the commit against GitHub, matches the bundle hash against published releases, and runs Sigstore attestation if the `gh` CLI is installed. Source: [`verify.sh`](verify.sh).

   This converts the trust assumption from _"trust ReadyStack"_ to _"trust GitHub's attestation infrastructure plus the CI workflow that built the release."_ It does not eliminate trust entirely — you are trusting GitHub Actions, the CI workflow definition, and the npm registry — but it is a meaningful reduction from trusting one person's VPS.

3. **Defense in depth at the relay origin.** The relay ships with:
   - **Strict CSP** with per-request nonces — blocks inline script injection and limits script sources to `'self'`
   - **Subresource Integrity (SRI)** — `sha384` hashes on every Vite-emitted script and stylesheet in `index.html`
   - **HSTS preload** — `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
   - **Standard hardening headers** — `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`
   - **Permissions-Policy** — disables 20+ browser features (camera, microphone, geolocation, etc.) that SpAIglass does not use

   These do not stop a compromised origin — the origin generates its own CSP nonces and SRI hashes — but they raise the cost of every other attack class: XSS, MITM, CDN compromise, clickjacking, and MIME confusion.

If your threat model rules out trusting the live relay, **self-host.** That is the only defense that does not depend on the relay operator's good behavior.

## Hardening notes for self-hosters

If you run your own SpAIglass relay or expose a host backend on the open internet:

- Always front the relay with TLS (the bundled `Caddyfile` does this with Let's Encrypt)
- Keep the SQLite connector database (`relay/relay.db`) on encrypted storage
- Rotate the GitHub OAuth client secret if you suspect compromise
- Keep `node`, `npm`, and the Claude Code CLI up to date on host machines
- Never run the host backend as root — the installers default to per-user services for this reason
- Treat connector tokens as secrets equivalent to SSH keys

Thank you for helping keep SpAIglass and its users safe.
