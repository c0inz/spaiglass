#!/usr/bin/env node

/**
 * Build script for esbuild bundling
 *
 * This script bundles the Node.js CLI application using esbuild.
 * Version information is handled via the auto-generated version.ts file.
 */

import { build } from "esbuild";

const COMMON = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: [
    "@anthropic-ai/claude-agent-sdk",
    "@hono/node-server",
    "hono",
    "commander",
    // ws ships internal dynamic require() calls that break when bundled into
    // an ESM output. Mark it external so node loads it from node_modules.
    "ws",
  ],
  // Some dependencies (e.g. logtape, dotenv) still emit CJS-style require()
  // calls. The banner gives the ESM output access to a CommonJS-style require
  // so those calls resolve at runtime instead of throwing.
  banner: {
    js: "import { createRequire as __spaiglassCreateRequire } from 'module'; const require = __spaiglassCreateRequire(import.meta.url);",
  },
  sourcemap: true,
};

// Backend (Claude Code WebUI server)
await build({
  ...COMMON,
  entryPoints: ["cli/node.ts"],
  outfile: "dist/cli/node.js",
});

// Relay connector — outbound WebSocket client that proxies the relay tunnel
// into the local backend. Built into the same dist/ tree so the systemd unit
// can launch both processes from $INSTALL_DIR/backend/dist.
await build({
  ...COMMON,
  entryPoints: ["connector.ts"],
  outfile: "dist/connector.js",
});

console.log("✅ Bundles created (cli/node.js + connector.js)");
