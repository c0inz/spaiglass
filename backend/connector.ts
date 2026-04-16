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
import { fileURLToPath } from "node:url";

// Module-scope state — populated by startConnector() so this file can be
// imported by cli/spaiglass-host.ts without auto-running, or executed
// standalone via `node connector.js` (legacy npm install path).
let RELAY_URL: string | undefined;
let CONNECTOR_TOKEN: string | undefined;
let CONNECTOR_ID: string | undefined;
let LOCAL_PORT = "8080";
let LOCAL_WS = "";
let SPAIGLASS_VERSION = "unknown";
let relayWsUrl = "";

const localSockets = new Map<string, WebSocket>();

let relayWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let authenticated = false;
// Keepalive. Upstream TLS proxies (DO droplet nginx, Caddy, etc.) idle-
// terminate WebSockets after ~60s of no traffic. Without this ping, a
// VM that sits idle gets silently disconnected from the relay, and the
// next browser reconnect sees "VM is offline" until the 3s backoff
// re-registers. Application-level pings work through any proxy.
let pingTimer: ReturnType<typeof setInterval> | null = null;
const RELAY_PING_INTERVAL_MS = 25_000;

function log(msg: string) {
  console.log(`[connector] ${new Date().toISOString()} ${msg}`);
}

function connectToRelay() {
  if (relayWs) {
    try {
      relayWs.close();
    } catch {}
  }

  authenticated = false;
  log(`Connecting to relay: ${relayWsUrl}`);

  relayWs = new WebSocket(relayWsUrl);

  relayWs.on("open", () => {
    log("Connected to relay, authenticating...");
    relayWs!.send(
      JSON.stringify({
        type: "auth",
        token: CONNECTOR_TOKEN,
        spaiglassVersion: SPAIGLASS_VERSION,
      }),
    );
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
      startPingTimer();
      return;
    }

    if (msg.type === "error") {
      log(`Relay error: ${msg.message}`);
      return;
    }

    // Keepalive — relay replies to our pings; we just consume pongs.
    if (msg.type === "pong") {
      return;
    }

    // HTTP proxy: relay forwards an HTTP request to serve locally
    if (msg.type === "http_request") {
      handleHttpRequest(msg);
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
    stopPingTimer();
    scheduleReconnect();
  });

  relayWs.on("error", (err) => {
    log(`Relay WebSocket error: ${err.message}`);
    authenticated = false;
  });
}

function startPingTimer() {
  stopPingTimer();
  pingTimer = setInterval(() => {
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN || !authenticated) {
      return;
    }
    try {
      relayWs.send(JSON.stringify({ type: "ping" }));
    } catch {
      // Send failure → the close handler will clean up and reconnect.
    }
  }, RELAY_PING_INTERVAL_MS);
}

function stopPingTimer() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToRelay();
  }, 3000);
}

/**
 * Handle an HTTP request from the relay.
 * Makes a local HTTP request to the backend and sends the response back.
 */
async function handleHttpRequest(msg: Record<string, unknown>) {
  const reqId = msg.reqId as string;
  const method = msg.method as string;
  const path = msg.path as string;
  const headers = (msg.headers || {}) as Record<string, string>;
  const rawBody = msg.body as string | undefined;
  const bodyEncoding = msg.bodyEncoding as "utf-8" | "base64" | undefined;

  const localUrl = `http://127.0.0.1:${LOCAL_PORT}${path}`;

  try {
    // Filter hop-by-hop headers and rewrite host
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (
        ![
          "host",
          "connection",
          "upgrade",
          "transfer-encoding",
          "keep-alive",
        ].includes(lk)
      ) {
        fwdHeaders[k] = v;
      }
    }
    fwdHeaders["host"] = `127.0.0.1:${LOCAL_PORT}`;

    // Decode body: base64 for binary (multipart/form-data), utf-8 for text
    let fetchBody: string | Buffer | undefined;
    if (method !== "GET" && method !== "HEAD" && rawBody) {
      fetchBody =
        bodyEncoding === "base64" ? Buffer.from(rawBody, "base64") : rawBody;
    }

    const resp = await fetch(localUrl, {
      method,
      headers: fwdHeaders,
      body: fetchBody,
      redirect: "manual",
    });

    const contentType = resp.headers.get("content-type") || "";
    const isText = /text|json|javascript|css|xml|svg|html|font\/woff/.test(
      contentType,
    );
    // Streaming responses (NDJSON, SSE) must be forwarded incrementally
    // rather than buffered — otherwise the browser gets everything at once.
    const isStreaming =
      contentType.includes("x-ndjson") || contentType.includes("event-stream");

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (
        !["transfer-encoding", "content-encoding", "connection"].includes(lk)
      ) {
        respHeaders[k] = v;
      }
    });

    if (isStreaming && resp.body) {
      // Stream: send headers immediately, then forward each chunk as it arrives.
      relayWs!.send(
        JSON.stringify({
          type: "http_stream_start",
          reqId,
          status: resp.status,
          headers: respHeaders,
        }),
      );

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text) {
            relayWs!.send(
              JSON.stringify({
                type: "http_stream_chunk",
                reqId,
                data: text,
              }),
            );
          }
        }
      } finally {
        relayWs!.send(JSON.stringify({ type: "http_stream_end", reqId }));
      }
    } else {
      // Buffered: read entire body, send as one message (existing behavior).
      let respBody: string;
      if (isText) {
        respBody = await resp.text();
      } else {
        const buf = Buffer.from(await resp.arrayBuffer());
        respBody = buf.toString("base64");
      }

      relayWs!.send(
        JSON.stringify({
          type: "http_response",
          reqId,
          status: resp.status,
          headers: respHeaders,
          body: respBody,
          bodyEncoding: isText ? "utf-8" : "base64",
        }),
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log(`HTTP proxy error for ${method} ${path}: ${message}`);
    relayWs!.send(
      JSON.stringify({
        type: "http_response",
        reqId,
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `Backend error: ${message}`,
        bodyEncoding: "utf-8",
      }),
    );
  }
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
  log(
    `New browser session: ${browserId.slice(0, 8)}... → opening local WS to ${LOCAL_WS}`,
  );

  local = new WebSocket(LOCAL_WS);
  localSockets.set(browserId, local);

  // Queue the initial message until the local socket opens
  local.on("open", () => {
    local!.send(data);
  });

  // Local backend → relay → browser
  local.on("message", (localData) => {
    if (relayWs && relayWs.readyState === WebSocket.OPEN && authenticated) {
      relayWs.send(
        JSON.stringify({
          type: "relay_response",
          browserId,
          data: localData.toString(),
        }),
      );
    }
  });

  local.on("close", () => {
    log(`Local WS closed for browser ${browserId.slice(0, 8)}...`);
    localSockets.delete(browserId);
  });

  local.on("error", (err) => {
    log(
      `Local WS error for browser ${browserId.slice(0, 8)}...: ${err.message}`,
    );
    localSockets.delete(browserId);
  });
}

// Clean up dead local sockets periodically
setInterval(() => {
  for (const [browserId, ws] of localSockets) {
    if (
      ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      localSockets.delete(browserId);
    }
  }
}, 30_000);

// Graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down...");
  if (relayWs) relayWs.close();
  for (const ws of localSockets.values()) {
    try {
      ws.close();
    } catch {}
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Shutting down...");
  if (relayWs) relayWs.close();
  for (const ws of localSockets.values()) {
    try {
      ws.close();
    } catch {}
  }
  process.exit(0);
});

/**
 * Initialise the connector and dial the relay.
 *
 * Reads RELAY_URL / CONNECTOR_TOKEN / CONNECTOR_ID / PORT / SPAIGLASS_VERSION
 * from process.env at call time. The unified spaiglass-host binary calls
 * this after the local backend is listening; the legacy `node connector.js`
 * standalone path calls it from the auto-run shim below.
 */
export function startConnector(): void {
  RELAY_URL = process.env.RELAY_URL;
  CONNECTOR_TOKEN = process.env.CONNECTOR_TOKEN;
  CONNECTOR_ID = process.env.CONNECTOR_ID;
  LOCAL_PORT = process.env.PORT || "8080";
  // SpAIglass install version (date string like "2026.04.10"). Written into
  // .env by install.sh so the relay can detect VMs on out-of-date installs.
  SPAIGLASS_VERSION = process.env.SPAIGLASS_VERSION || "unknown";
  LOCAL_WS = `ws://127.0.0.1:${LOCAL_PORT}/api/ws`;

  if (!RELAY_URL || !CONNECTOR_TOKEN) {
    console.error("Missing RELAY_URL or CONNECTOR_TOKEN in .env");
    process.exit(1);
  }

  relayWsUrl =
    RELAY_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:") +
    "/connector";

  log("SpAIglass Relay Connector Client");
  log(`Relay: ${RELAY_URL}`);
  log(`Local backend: ${LOCAL_WS}`);
  log(`Connector ID: ${CONNECTOR_ID || "(from token)"}`);
  connectToRelay();
}

// Auto-run when this file is loaded directly via `node connector.js` (the
// legacy npm-based install path). Skip auto-run when bundled into the
// bun-compiled single binary — there, cli/spaiglass-host.ts is the unique
// entry point and calls startConnector() explicitly after the backend is
// listening.
const here =
  import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url));
const isCompiledBundle = here.startsWith("/$bunfs");

if (!isCompiledBundle) {
  config({ path: resolve(here, ".env") });
  startConnector();
}
