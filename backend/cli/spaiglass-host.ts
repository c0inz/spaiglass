#!/usr/bin/env node
/**
 * Unified single-binary entry point for the SpAIglass host.
 *
 * Runs both the local HTTP/WS backend and the relay connector in one
 * process, replacing the legacy two-process layout where install.sh
 * spawned `node backend/dist/cli/node.js` and `node backend/dist/connector.js`
 * separately under one systemd unit.
 *
 * Used as the entry point for `bun build --compile` (see scripts/build-binary.sh).
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { runNodeBackend } from "./node.ts";
import { startConnector } from "../connector.ts";
import { logger } from "../utils/logger.ts";
import { registerProjects } from "../utils/register-projects.ts";

// Load .env from the binary's working directory so the systemd unit's
// EnvironmentFile= isn't strictly required, and so a user running the binary
// by hand from its install dir Just Works.
config({ path: resolve(process.cwd(), ".env") });

async function main() {
  // Auto-register ~/projects/*/agents/ in ~/.claude.json before starting the
  // backend. Used to be done by `node -e ...` from install.sh; lives here now
  // so the Phase 3 installer can drop the node prerequisite entirely.
  registerProjects();

  // Start the local backend first. runNodeBackend resolves once the HTTP
  // server is bound — at that point the connector can safely dial /api/ws.
  await runNodeBackend();

  // Tiny delay to give the listener a tick to settle before the connector
  // makes its first local-WS attempt. The connector retries on failure
  // anyway, but this avoids a noisy "ECONNREFUSED" line on cold start.
  await new Promise((r) => setTimeout(r, 250));

  startConnector();
  logger.cli.info("🛰  Connector started — host is now relay-attached");
}

main().catch((err) => {
  console.error("spaiglass-host failed to start:", err);
  process.exit(1);
});
