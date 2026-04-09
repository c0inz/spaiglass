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
import { getConnectorByToken, getConnectorById, touchConnector } from "./db.ts";

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
}

class ChannelManager {
  private channels = new Map<string, ConnectorChannel>(); // connectorId -> channel
  private httpPending = new Map<string, PendingHttpRequest>();

  /** Register a VM connector */
  register(connectorId: string, userId: string, ws: WSContext): void {
    // Disconnect existing connection if any
    this.disconnect(connectorId);
    this.channels.set(connectorId, {
      connectorId,
      userId,
      ws,
      browsers: new Map(),
    });
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
  httpRequest(connectorId: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<HttpProxyResponse> {
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

        // Register the connector channel
        cm.register(connector.id, connector.user_id, ws);
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
 * Validates ownership before connecting.
 */
export function createBrowserWsHandler(connectorId: string, userId: string) {
  const cm = getChannelManager();
  const browserId = crypto.randomUUID();

  return {
    onOpen(ws: WSContext) {
      // Validate connector exists and belongs to user
      const connector = getConnectorById(connectorId);
      if (!connector || connector.user_id !== userId) {
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
      }));
    },

    onMessage(ws: WSContext, event: MessageEvent) {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
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
