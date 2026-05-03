# Notices

## Upstream attribution

SpAIglass began as a fork of [Claude Code Web UI](https://github.com/sugyan/claude-code-webui) by sugyan, used under the terms of the MIT license. The original copyright is preserved here as required by the license:

> Copyright (c) 2025 Claude Code Web UI

The current SpAIglass codebase has diverged substantially from the upstream — the relay, fleet management, multi-VM tunneling, persistence layer, deployment pipeline, and most of the UI are independent work by ReadyStack.dev under the same MIT license (see [LICENSE](LICENSE)).

If you contributed to or maintain Claude Code Web UI and would like the attribution worded differently, open an issue and we'll adjust.

## Third-party dependencies

Direct dependencies are listed in `frontend/package.json`, `backend/package.json`, and `relay/package.json`. Each carries its own license; install-time tooling (npm) reproduces those licenses in `node_modules`. SpAIglass is distributed as source — no third-party code is statically embedded in our repository — so consumers who build or run SpAIglass install those dependencies themselves and are bound by their respective licenses at install time.
