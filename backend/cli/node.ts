#!/usr/bin/env node
/**
 * Node.js-specific entry point
 *
 * Handles CLI argument parsing, Claude CLI validation, WebSocket setup,
 * and server startup using the NodeRuntime.
 */

import { createApp, finalizeSpa } from "../app.ts";
import { NodeRuntime } from "../runtime/node.ts";
import { parseCliArgs } from "./args.ts";
import { validateClaudeCli } from "./validation.ts";
import { setupLogger, logger } from "../utils/logger.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exit } from "../utils/os.ts";
import { createNodeWebSocket } from "@hono/node-ws";
import { SessionManager } from "../session/manager.ts";
import { createWSHandler } from "../session/ws-handler.ts";
import { registerProjects } from "../utils/register-projects.ts";

/**
 * Boot the local backend (HTTP + WebSocket) and return once it is listening.
 * Exported so the unified single-binary entry point (cli/spaiglass-host.ts)
 * can start the backend, then start the connector in the same process.
 */
export async function runNodeBackend(): Promise<void> {
  const runtime = new NodeRuntime();
  return main(runtime);
}

async function main(runtime: NodeRuntime) {
  const args = parseCliArgs();
  await setupLogger(args.debug);

  if (args.debug) {
    logger.cli.info("🐛 Debug mode enabled");
  }

  // Auto-register ~/projects/*/agents/ in ~/.claude.json so every project
  // with a role file shows up in the dropdown. Phase 3 binary does this in
  // spaiglass-host.ts; the legacy npm-install path needs it here too.
  registerProjects();

  const cliPath = await validateClaudeCli(runtime, args.claudePath);

  // Static files location:
  //  - Normal node run: ../static relative to this source file (backend/static)
  //  - bun --compile binary: import.meta.dirname is the in-memory /$bunfs root,
  //    which has no real static files. Fall back to <binary_dir>/static so the
  //    build script can ship a `static/` directory next to the executable.
  const __dirname =
    import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  const isCompiledBinary = __dirname.startsWith("/$bunfs");
  const staticPath = isCompiledBinary
    ? join(dirname(process.execPath), "static")
    : join(__dirname, "../static");

  // Create the Hono app with all routes
  const app = createApp(runtime, {
    debugMode: args.debug,
    staticPath,
    cliPath,
  });

  // Create SessionManager for persistent Claude sessions
  const sessionManager = new SessionManager(cliPath);

  // Set up WebSocket support on the real app
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const wsHandler = createWSHandler(sessionManager);

  // Register WS route — must use app.get() directly since createApp
  // already registered the SPA fallback. Hono matches routes in order
  // of specificity, so an exact path match on /api/ws wins over the * catch-all.
  app.get(
    "/api/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        wsHandler.onOpen(ws);
      },
      onMessage(event, ws) {
        wsHandler.onMessage(ws, event);
      },
      onClose(_event, ws) {
        wsHandler.onClose(ws);
      },
      onError(event, ws) {
        wsHandler.onError(ws, event);
      },
    })),
  );

  // Add SPA fallback AFTER WebSocket route so WS upgrade isn't caught by catch-all
  finalizeSpa(app, staticPath);

  // Start server — pass the app's fetch handler directly
  logger.cli.info(`🚀 Server starting on ${args.host}:${args.port}`);
  const server = runtime.serve(args.port, args.host, app.fetch);

  // Inject WebSocket upgrade handling into the HTTP server
  injectWebSocket(server);

  // Phase 1: session GC sweep every 60s, default idle threshold 30 min
  // (set in SessionManager.cleanup). Sessions producing live output stay
  // alive because broadcast() updates lastActivity on every frame.
  setInterval(() => {
    const cleaned = sessionManager.cleanup();
    if (cleaned > 0) {
      logger.cli.info(`🧹 Cleaned up ${cleaned} inactive sessions`);
    }
  }, 60 * 1000);

  logger.cli.info("🔌 WebSocket endpoint ready at /api/ws");
}

// Auto-run when this file is the process entry point (legacy
// `node backend/dist/cli/node.js` path used by the pre-Phase-3 npm install).
//
// We can't use a `import.meta.url === argv[1]` check here because under
// `bun build --compile`, every bundled module sees the same import.meta.url
// (the binary path), which makes that check spuriously true for non-entry
// modules. Instead, skip auto-run entirely when running inside the compiled
// binary — there, cli/spaiglass-host.ts is the unique entry point and it
// imports runNodeBackend() explicitly.
const __dirname_check =
  import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const isCompiledBundle = __dirname_check.startsWith("/$bunfs");

if (!isCompiledBundle) {
  const runtime = new NodeRuntime();
  main(runtime).catch((error) => {
    console.error("Failed to start server:", error);
    exit(1);
  });
}
