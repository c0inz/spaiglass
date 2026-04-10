# Contributing to SpAIglass

Thanks for your interest in contributing. SpAIglass is a small project run by [ReadyStack.dev](https://readystack.dev) and we welcome external contributions of all sizes — bug reports, doc fixes, host platform tweaks, security review, and feature work.

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

If you are reporting a **security vulnerability**, please do not open a public issue. Follow the private disclosure process in [SECURITY.md](SECURITY.md) instead.

---

## What kinds of contributions we want

| Welcome | Notes |
|---|---|
| Bug fixes with a regression test | The most welcome PRs |
| Host platform support (BSD, additional Linux init systems, Windows variants) | Keep installers idempotent and per-user where possible |
| Documentation improvements | Especially anything that helps a new contributor get the relay or a host running locally in under 10 minutes |
| Security hardening of the relay | Review of `relay/src/tunnel.ts`, `auth.ts`, `middleware.ts`, `db.ts` |
| Theme and accessibility work | New themes, screen-reader fixes, keyboard navigation |
| Test coverage on the backend session manager and connector | Currently the thinnest area |

| Please discuss first (open an issue) | Notes |
|---|---|
| Large refactors of the relay or connector tunnel | These touch the security model |
| New persistent state in the relay | The relay is intentionally stateless beyond the connector registry |
| New external dependencies in the relay | We try to keep the relay auditable in an afternoon |
| Net-new features that change the UX significantly | Worth aligning on scope before code |

---

## Repository layout

| Directory | What it is |
|---|---|
| `relay/` | SGCleanRelay — stateless routing proxy (Hono + SQLite). Hosted at `spaiglass.xyz`. |
| `backend/` | Per-host backend that spawns the Claude Code CLI and serves the file/editor APIs. Bundled into a slim tarball at release time. |
| `frontend/` | React UI. Built once and served by the relay so hosts only ship the backend. |
| `relay/release/` | Host installer scripts (`install.sh`, `install.ps1`) and the packed `dist.tar.gz` the relay serves. |
| `research/` | Design specs and investigation notes. |
| `agents/` | Role definitions Claude sessions can be launched against. |

The top-level docs (`README.md`, `ARCHITECTURE.md`, `FEATURES.md`, `REQUIREMENTS.md`, `TASKS.md`) are kept in sync with the code — please update them in the same PR when behavior changes.

---

## Local development

### Prerequisites

- Node.js >= 20 (we test on 20 and 24 in CI)
- npm
- Anthropic Claude Code CLI installed and authenticated on your machine — the backend spawns it directly
- For relay work: a GitHub OAuth app (you can create a throwaway one for `localhost`)

### Run the relay locally

```bash
cd relay
cp .env.example .env
# Edit .env with your GitHub OAuth credentials and any test secrets
npm install
npx tsx src/server.ts
```

The relay listens on `http://localhost:8787` by default and serves the bundled frontend out of `relay/dist/`. You can point a real host at it by setting `SPAIGLASS_RELAY_URL=ws://localhost:8787` in the host's `.env`.

### Run the backend against your own machine

```bash
cd backend
npm install
npm run dev
```

This runs the backend on `127.0.0.1:8080` against your home directory. Without a connector token it will not dial out — useful for backend-only work.

### Run the frontend against a local backend

```bash
cd frontend
npm install
npm run dev
```

Vite dev server proxies API calls to the backend on `:8080`.

### Build everything the way CI does

```bash
# Backend (matches CI)
cd backend
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build

# Frontend (matches CI)
cd ../frontend
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

If formatting or lint fails, run `npm run format` and `npm run lint -- --fix` before committing.

---

## Pull request process

1. **Open an issue first** for anything larger than a one-line fix. We will tag it `accepted` once we agree on direction.
2. **Branch from `main`**. Use a short topic name: `fix/connector-reconnect-loop`, `feat/macos-launchd-uninstall`, `docs/contributing-guide`.
3. **Keep PRs focused**. One logical change per PR. If your branch starts touching unrelated areas, split it.
4. **Write or update tests** for any backend or relay change. UI-only changes do not require tests but a screenshot in the PR description is helpful.
5. **Run the CI commands locally** before pushing (see "Build everything the way CI does" above). The CI workflow on `main` is the contract — green CI is required for merge.
6. **Update docs in the same PR** when behavior changes. README, ARCHITECTURE, FEATURES, and the in-repo `/setup` HTML must stay consistent.
7. **Sign your commits** if possible (`git commit -S`). Not required, but recommended for the security boundary code.
8. **Open the PR against `main`** using the PR template. Include:
   - What problem this solves
   - How you verified it (tests, manual steps, screenshots)
   - Any rollout or migration concerns
9. **Address review feedback in new commits**. We squash on merge, so don't worry about cleaning up history.

A maintainer will review within a few business days. If you don't hear back in a week, ping the PR — we sometimes miss notifications.

---

## Coding standards

- **TypeScript everywhere.** No `any` without a comment explaining why.
- **Prettier** is the source of truth for formatting. Run `npm run format` in the directory you touched.
- **ESLint** must pass with zero warnings.
- **No new top-level dependencies in the relay** without discussion. The relay's auditable surface is a feature.
- **Comments explain why, not what.** Self-explanatory code is preferred over commented code.
- **Error messages should be actionable.** "Connection failed" is not enough — say what to check.
- **Cross-platform paths.** Use `node:path` and `os.homedir()`, never hard-code `/` or `~`. Hosts run on Linux, macOS, and Windows.

---

## Reporting bugs

Open an issue using the **Bug report** template. Please include:

- SpAIglass version (relay commit or host release tag)
- Host platform and version (Linux distro, macOS version, or Windows build)
- Node.js version
- Claude Code CLI version (`claude --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant log lines from the relay or host (`journalctl --user -u spaiglass` on Linux, `~/Library/Logs/spaiglass` on macOS, the Scheduled Task history on Windows)

For security issues, see [SECURITY.md](SECURITY.md). Do not open a public issue.

---

## Getting help

- **Questions and discussion:** GitHub Discussions (enable on the repo if not already on)
- **Issue tracker:** for bugs and feature requests only
- **Email:** `hello@readystack.dev` for non-security questions that don't fit a public issue

---

## License

By contributing to SpAIglass you agree that your contributions will be licensed under the [MIT License](LICENSE), the same license as the rest of the project. You retain copyright on your contributions; the MIT grant gives the project and its users the right to use them.
