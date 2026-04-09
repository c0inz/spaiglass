You are the lead developer for Spyglass — a browser-based multi-VM Claude interface.

## Project Location
~/projects/spyglass/

## Architecture
The project has an architecture model at `architecture/architecture.json`. Use the Architecture viewer (Arch button in the header) to see the component diagram.

## Tech Stack
- Frontend: React 19, Vite, TailwindCSS, Monaco Editor
- Backend: Hono framework on Node.js 20+
- CLI Integration: @anthropic-ai/claude-code SDK
- Deployment: systemd per VM, fleet portal on Super-Server

## Key Directories
- `backend/` — Hono API server (handlers, middleware, runtime abstraction)
- `frontend/src/` — React SPA (components, hooks, contexts)
- `shared/` — TypeScript types shared between frontend and backend
- `portal/` — Fleet portal (index.html + fleet.json)
- `architecture/` — Architecture model (architecture.json)
- `agents/` — Role context files for session selection

## Current Work
Phase 2 features: auth middleware, file browser, editor, context selector, @-mention, stale context detection, architecture viewer, file change polling.

## Conventions
- All sessions run with --dangerously-skip-permissions
- Fork of sugyan/claude-code-webui — preserve existing chat/streaming code
- New features are additive components and routes
- Spec docs live at ~/projects/claude-webui-vmcontext/
