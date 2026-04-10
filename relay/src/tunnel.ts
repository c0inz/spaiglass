/**
 * WebSocket tunnel — bridges browsers to SpAIglass VMs.
 *
 * Three proxy modes:
 * - /connector — VM inbound: VM connects, sends token, gets registered
 * - /vm/:slug/api/ws — Browser WebSocket: tunneled to VM's /api/ws
 * - /vm/:slug/* — Browser HTTP: proxied to VM backend via HTTP-over-WebSocket
 *
 * The relay is transparent — all messages are forwarded without inspection.
 */

import type { WSContext } from "hono/ws";
import {
  getConnectorByToken,
  getConnectorById,
  touchConnector,
  getConnectorAccess,
  type ConnectorRole,
} from "./db.ts";

/**
 * Phase 2: write-type WS message kinds that a viewer is NOT allowed to send.
 * Anything not in this set (e.g. `resume`) is forwarded so viewers can still
 * attach to live sessions and replay buffered frames.
 */
const VIEWER_BLOCKED_TYPES = new Set([
  "message",
  "interrupt",
  "session_start",
  "session_restart",
]);

export interface HttpProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: "utf-8" | "base64";
}

interface PendingHttpRequest {
  resolve: (resp: HttpProxyResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConnectorChannel {
  connectorId: string;
  userId: string;
  ws: WSContext;
  browsers: Map<string, WSContext>; // browserId -> browser WS
  spaiglassVersion: string; // version reported by VM on auth, e.g. "2026.04.10"
}

class ChannelManager {
  private channels = new Map<string, ConnectorChannel>(); // connectorId -> channel
  private httpPending = new Map<string, PendingHttpRequest>();

  /** Register a VM connector */
  register(connectorId: string, userId: string, ws: WSContext, spaiglassVersion: string): void {
    // Disconnect existing connection if any
    this.disconnect(connectorId);
    this.channels.set(connectorId, {
      connectorId,
      userId,
      ws,
      browsers: new Map(),
      spaiglassVersion,
    });
  }

  /** Get the spaiglass version reported by a connector on auth, or null if offline */
  getVersion(connectorId: string): string | null {
    return this.channels.get(connectorId)?.spaiglassVersion ?? null;
  }

  /** Remove a VM connector */
  disconnect(connectorId: string): void {
    const channel = this.channels.get(connectorId);
    if (!channel) return;

    // Close all browser connections
    for (const browserWs of channel.browsers.values()) {
      try {
        browserWs.send(JSON.stringify({ type: "error", message: "VM disconnected" }));
        browserWs.close();
      } catch { /* ignore */ }
    }
    this.channels.delete(connectorId);
  }

  /** Check if a connector is online */
  isOnline(connectorId: string): boolean {
    return this.channels.has(connectorId);
  }

  /** Get channel for a connector */
  getChannel(connectorId: string): ConnectorChannel | undefined {
    return this.channels.get(connectorId);
  }

  /** Add a browser to a connector channel */
  addBrowser(connectorId: string, browserId: string, ws: WSContext): boolean {
    const channel = this.channels.get(connectorId);
    if (!channel) return false;
    channel.browsers.set(browserId, ws);
    return true;
  }

  /** Remove a browser from a connector channel */
  removeBrowser(connectorId: string, browserId: string): void {
    const channel = this.channels.get(connectorId);
    if (!channel) return;
    channel.browsers.delete(browserId);
  }

  /** Forward message from browser to VM */
  browserToVm(connectorId: string, browserId: string, data: string): void {
    const channel = this.channels.get(connectorId);
    if (!channel) return;

    try {
      // Wrap with browser ID so VM can route responses
      channel.ws.send(JSON.stringify({
        type: "relay_forward",
        browserId,
        data,
      }));
    } catch { /* VM disconnected */ }
  }

  /** Forward message from VM to a specific browser */
  vmToBrowser(connectorId: string, browserId: string, data: string): void {
    const channel = this.channels.get(connectorId);
    if (!channel) return;

    const browserWs = channel.browsers.get(browserId);
    if (!browserWs) return;

    try {
      browserWs.send(data);
    } catch { /* browser disconnected */ }
  }

  /** Broadcast from VM to all browsers on this channel */
  vmBroadcast(connectorId: string, data: string): void {
    const channel = this.channels.get(connectorId);
    if (!channel) return;

    for (const browserWs of channel.browsers.values()) {
      try {
        browserWs.send(data);
      } catch { /* ignore */ }
    }
  }

  /** Proxy an HTTP request through the connector WebSocket tunnel */
  httpRequest(connectorId: string, method: string, path: string, headers: Record<string, string>, body?: string, bodyEncoding?: "utf-8" | "base64"): Promise<HttpProxyResponse> {
    const channel = this.channels.get(connectorId);
    if (!channel) return Promise.reject(new Error("VM offline"));

    const reqId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.httpPending.delete(reqId);
        reject(new Error("HTTP proxy timeout"));
      }, 30_000);

      this.httpPending.set(reqId, { resolve, reject, timer });

      try {
        channel.ws.send(JSON.stringify({
          type: "http_request",
          reqId,
          method,
          path,
          headers,
          body,
          bodyEncoding,
        }));
      } catch {
        clearTimeout(timer);
        this.httpPending.delete(reqId);
        reject(new Error("Failed to send to VM"));
      }
    });
  }

  /** Resolve a pending HTTP proxy request with the VM's response */
  resolveHttpResponse(reqId: string, response: HttpProxyResponse): void {
    const pending = this.httpPending.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.httpPending.delete(reqId);
    pending.resolve(response);
  }

  stats(): { connectors: number; browsers: number } {
    let browsers = 0;
    for (const ch of this.channels.values()) {
      browsers += ch.browsers.size;
    }
    return { connectors: this.channels.size, browsers };
  }
}

// Singleton
let channelManager: ChannelManager;

export function getChannelManager(): ChannelManager {
  if (!channelManager) channelManager = new ChannelManager();
  return channelManager;
}

/**
 * Handle VM connector WebSocket.
 * Protocol: VM sends { type: "auth", token: "..." } as first message.
 * After auth, all messages are forwarded to/from browsers.
 */
export function handleConnectorWs() {
  const cm = getChannelManager();

  return {
    onMessage(ws: WSContext, event: MessageEvent) {
      let msg: Record<string, unknown>;
      try {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        msg = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      // Handle auth
      if (msg.type === "auth") {
        const token = msg.token as string;
        if (!token) {
          ws.send(JSON.stringify({ type: "error", message: "Token required" }));
          ws.close();
          return;
        }

        const connector = getConnectorByToken(token);
        if (!connector) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
          ws.close();
          return;
        }

        // Register the connector channel; record the spaiglass install version
        // the VM is running so the dashboard can show an out-of-date banner.
        const version = (typeof msg.spaiglassVersion === "string" && msg.spaiglassVersion) || "unknown";
        cm.register(connector.id, connector.user_id, ws, version);
        touchConnector(connector.id);

        // Store connector ID on the WS for cleanup
        connectorWsMap.set(ws, connector.id);

        ws.send(JSON.stringify({
          type: "auth_ok",
          connectorId: connector.id,
          name: connector.name,
        }));
        return;
      }

      // Handle http_response from VM → pending HTTP proxy request
      if (msg.type === "http_response") {
        const reqId = msg.reqId as string;
        if (reqId) {
          cm.resolveHttpResponse(reqId, {
            status: msg.status as number,
            headers: (msg.headers || {}) as Record<string, string>,
            body: (msg.body || "") as string,
            bodyEncoding: msg.bodyEncoding as "utf-8" | "base64" | undefined,
          });
        }
        return;
      }

      // Handle relay_response from VM → browser
      if (msg.type === "relay_response") {
        const connectorId = connectorWsMap.get(ws);
        if (!connectorId) return;

        const browserId = msg.browserId as string;
        const data = msg.data as string;

        if (browserId) {
          cm.vmToBrowser(connectorId, browserId, data);
        } else {
          // Broadcast to all browsers
          cm.vmBroadcast(connectorId, data);
        }
        return;
      }
    },

    onClose(ws: WSContext) {
      const connectorId = connectorWsMap.get(ws);
      if (connectorId) {
        cm.disconnect(connectorId);
        connectorWsMap.delete(ws);
      }
    },

    onError(ws: WSContext) {
      const connectorId = connectorWsMap.get(ws);
      if (connectorId) {
        cm.disconnect(connectorId);
        connectorWsMap.delete(ws);
      }
    },
  };
}

// Track which WS belongs to which connector
const connectorWsMap = new WeakMap<WSContext, string>();

/**
 * Handle browser WebSocket to a specific VM.
 * Validates access (owner or collaborator) before connecting.
 *
 * Phase 2: `role` is passed in by server.ts after consulting vm_collaborators.
 * For `viewer`, the relay enforces read-only by:
 *   - Blocking write-type WS messages (message/interrupt) entirely
 *   - Rewriting session_start/session_restart to `resume` with lastCursor=0,
 *     so a viewer "attach" never spawns a Claude process — it can only attach
 *     to a session the owner already started.
 *   - Surfacing the role in the `connected` frame so the frontend can hide
 *     the input bar and show a viewer banner.
 */
export function createBrowserWsHandler(
  connectorId: string,
  userId: string,
  role: ConnectorRole,
) {
  const cm = getChannelManager();
  const browserId = crypto.randomUUID();

  return {
    onOpen(ws: WSContext) {
      // Re-check access at attach time. The role passed in by server.ts is the
      // snapshot from the upgrade handshake; if the owner removed this user
      // between then and now (rare), reject here.
      const currentRole = getConnectorAccess(connectorId, userId);
      if (!currentRole) {
        ws.send(JSON.stringify({ type: "error", message: "Connector not found" }));
        ws.close();
        return;
      }

      // Check if VM is online
      if (!cm.isOnline(connectorId)) {
        ws.send(JSON.stringify({ type: "error", message: "VM is offline" }));
        ws.close();
        return;
      }

      // Register browser in the channel
      cm.addBrowser(connectorId, browserId, ws);

      ws.send(JSON.stringify({
        type: "connected",
        connectorId,
        browserId,
        role: currentRole,
      }));
    },

    onMessage(ws: WSContext, event: MessageEvent) {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();

      // Owners and editors: forward opaquely (the relay does not inspect content).
      if (role !== "viewer") {
        cm.browserToVm(connectorId, browserId, raw);
        return;
      }

      // Viewers: parse only the `type` field for permission enforcement.
      // We do NOT read or log message content.
      let parsed: { type?: unknown; roleFile?: unknown; workingDirectory?: unknown } | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Non-JSON frame from a viewer is dropped.
        ws.send(JSON.stringify({ type: "error", message: "Invalid frame (viewer)" }));
        return;
      }

      const type = typeof parsed?.type === "string" ? parsed.type : "";

      if (VIEWER_BLOCKED_TYPES.has(type)) {
        // session_start / session_restart are rewritten to a passive resume so
        // the viewer can attach without spawning a new Claude process.
        if (type === "session_start" || type === "session_restart") {
          const rewritten = JSON.stringify({
            type: "resume",
            roleFile: parsed?.roleFile,
            workingDirectory: parsed?.workingDirectory,
            lastCursor: 0,
          });
          cm.browserToVm(connectorId, browserId, rewritten);
          return;
        }
        // message / interrupt are hard-blocked.
        ws.send(
          JSON.stringify({
            type: "viewer_blocked",
            blockedType: type,
            message: "Read-only access (viewer role)",
          }),
        );
        return;
      }

      // Anything else (resume, ping, etc.) flows through.
      cm.browserToVm(connectorId, browserId, raw);
    },

    onClose() {
      cm.removeBrowser(connectorId, browserId);
    },

    onError() {
      cm.removeBrowser(connectorId, browserId);
    },
  };
}
