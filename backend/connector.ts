/**
 * SpAIglass Relay Connector Client
 *
 * Runs on the VM alongside the backend. Connects outbound to the relay
 * and bridges WebSocket traffic between remote browsers and the local
 * backend's /api/ws endpoint.
 *
 * One outbound WebSocket to the relay, one local WebSocket per browser.
 *
 * Usage:
 *   npx tsx connector.ts
 *
 * Reads from .env: RELAY_URL, CONNECTOR_TOKEN, CONNECTOR_ID
 * Also needs the backend running locally on PORT (default 8080).
 */

import WebSocket from "ws";
import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env from same directory
config({ path: resolve(import.meta.dirname ?? ".", ".env") });

const RELAY_URL = process.env.RELAY_URL;
const CONNECTOR_TOKEN = process.env.CONNECTOR_TOKEN;
const CONNECTOR_ID = process.env.CONNECTOR_ID;
const LOCAL_PORT = process.env.PORT || "8080";
const LOCAL_HOST = process.env.HOST || "0.0.0.0";
const LOCAL_WS = `ws://127.0.0.1:${LOCAL_PORT}/api/ws`;

if (!RELAY_URL || !CONNECTOR_TOKEN) {
  console.error("Missing RELAY_URL or CONNECTOR_TOKEN in .env");
  process.exit(1);
}

// Convert RELAY_URL to WebSocket URL
const relayWsUrl = RELAY_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/connector";

// Track local WebSocket connections per browser session
const localSockets = new Map<string, WebSocket>();

let relayWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let authenticated = false;

function log(msg: string) {
  console.log(`[connector] ${new Date().toISOString()} ${msg}`);
}

function connectToRelay() {
  if (relayWs) {
    try { relayWs.close(); } catch {}
  }

  authenticated = false;
  log(`Connecting to relay: ${relayWsUrl}`);

  relayWs = new WebSocket(relayWsUrl);

  relayWs.on("open", () => {
    log("Connected to relay, authenticating...");
    relayWs!.send(JSON.stringify({ type: "auth", token: CONNECTOR_TOKEN }));
  });

  relayWs.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log("Invalid JSON from relay");
      return;
    }

    // Auth response
    if (msg.type === "auth_ok") {
      authenticated = true;
      log(`Authenticated as connector: ${msg.name} (${msg.connectorId})`);
      return;
    }

    if (msg.type === "error") {
      log(`Relay error: ${msg.message}`);
      return;
    }

    // Browser → VM: relay forwards a browser message
    if (msg.type === "relay_forward") {
      const browserId = msg.browserId as string;
      const data = msg.data as string;
      handleBrowserMessage(browserId, data);
      return;
    }
  });

  relayWs.on("close", () => {
    log("Disconnected from relay");
    authenticated = false;
    scheduleReconnect();
  });

  relayWs.on("error", (err) => {
    log(`Relay WebSocket error: ${err.message}`);
    authenticated = false;
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToRelay();
  }, 3000);
}

/**
 * Handle a message from a browser (forwarded by the relay).
 * Creates or reuses a local WebSocket to the backend for this browser.
 */
function handleBrowserMessage(browserId: string, data: string) {
  let local = localSockets.get(browserId);

  if (local && local.readyState === WebSocket.OPEN) {
    // Forward to existing local connection
    local.send(data);
    return;
  }

  // Create new local WebSocket for this browser session
  log(`New browser session: ${browserId.slice(0, 8)}... → opening local WS to ${LOCAL_WS}`);

  local = new WebSocket(LOCAL_WS);
  localSockets.set(browserId, local);

  // Queue the initial message until the local socket opens
  local.on("open", () => {
    local!.send(data);
  });

  // Local backend → relay → browser
  local.on("message", (localData) => {
    if (relayWs && relayWs.readyState === WebSocket.OPEN && authenticated) {
      relayWs.send(JSON.stringify({
        type: "relay_response",
        browserId,
        data: localData.toString(),
      }));
    }
  });

  local.on("close", () => {
    log(`Local WS closed for browser ${browserId.slice(0, 8)}...`);
    localSockets.delete(browserId);
  });

  local.on("error", (err) => {
    log(`Local WS error for browser ${browserId.slice(0, 8)}...: ${err.message}`);
    localSockets.delete(browserId);
  });
}

// Clean up dead local sockets periodically
setInterval(() => {
  for (const [browserId, ws] of localSockets) {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      localSockets.delete(browserId);
    }
  }
}, 30_000);

// Graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down...");
  if (relayWs) relayWs.close();
  for (const ws of localSockets.values()) {
    try { ws.close(); } catch {}
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Shutting down...");
  if (relayWs) relayWs.close();
  for (const ws of localSockets.values()) {
    try { ws.close(); } catch {}
  }
  process.exit(0);
});

// Start
log("SpAIglass Relay Connector Client");
log(`Relay: ${RELAY_URL}`);
log(`Local backend: ${LOCAL_WS}`);
log(`Connector ID: ${CONNECTOR_ID || "(from token)"}`);
connectToRelay();
