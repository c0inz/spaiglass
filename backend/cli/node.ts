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

async function main(runtime: NodeRuntime) {
  const args = parseCliArgs();
  await setupLogger(args.debug);

  if (args.debug) {
    logger.cli.info("🐛 Debug mode enabled");
  }

  const cliPath = await validateClaudeCli(runtime, args.claudePath);

  const __dirname =
    import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  const staticPath = join(__dirname, "../static");

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

  // Session cleanup every hour
  setInterval(
    () => {
      const cleaned = sessionManager.cleanup();
      if (cleaned > 0) {
        logger.cli.info(`🧹 Cleaned up ${cleaned} inactive sessions`);
      }
    },
    60 * 60 * 1000,
  );

  logger.cli.info("🔌 WebSocket endpoint ready at /api/ws");
}

const runtime = new NodeRuntime();
main(runtime).catch((error) => {
  console.error("Failed to start server:", error);
  exit(1);
});
