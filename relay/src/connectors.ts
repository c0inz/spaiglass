/**
 * Connector (VM) management routes.
 */

import { Hono } from "hono";
import {
  createConnector,
  getConnectorsByUser,
  getConnectorById,
  deleteConnector,
} from "./db.ts";
import { requireAuth } from "./middleware.ts";
import { getChannelManager } from "./tunnel.ts";
import type { RelayEnv } from "./types.ts";

export function connectorRoutes(): Hono<RelayEnv> {
  const app = new Hono<RelayEnv>();

  // All connector routes require auth
  app.use("/api/connectors/*", requireAuth());

  // List connectors with online/offline status
  app.get("/api/connectors", (c) => {
    const user = c.get("user")!;
    const connectors = getConnectorsByUser(user.id);
    const cm = getChannelManager();

    return c.json(connectors.map((conn) => ({
      id: conn.id,
      name: conn.name,
      online: cm.isOnline(conn.id),
      lastSeen: conn.last_seen,
      createdAt: conn.created_at,
    })));
  });

  // Register a new connector
  app.post("/api/connectors", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ name: string }>();

    if (!body.name || typeof body.name !== "string" || body.name.length > 100) {
      return c.json({ error: "Name is required (max 100 chars)" }, 400);
    }

    const connector = createConnector(user.id, body.name.trim());
    return c.json({
      id: connector.id,
      name: connector.name,
      token: connector.token,
      createdAt: connector.created_at,
    }, 201);
  });

  // Delete a connector
  app.delete("/api/connectors/:id", (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const deleted = deleteConnector(id, user.id);
    if (!deleted) {
      return c.json({ error: "Connector not found" }, 404);
    }
    // Disconnect if online
    getChannelManager().disconnect(id);
    return c.json({ ok: true });
  });

  // Download .env config for a connector
  app.get("/api/connectors/:id/config", (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const connector = getConnectorById(id);

    if (!connector || connector.user_id !== user.id) {
      return c.json({ error: "Connector not found" }, 404);
    }

    const publicUrl = c.env.PUBLIC_URL;
    const envContent = [
      `# SpAIglass VM Connector Configuration`,
      `# Generated for: ${connector.name}`,
      `# Relay: ${publicUrl}`,
      ``,
      `RELAY_URL=${publicUrl}`,
      `CONNECTOR_TOKEN=${connector.token}`,
      `CONNECTOR_ID=${connector.id}`,
      ``,
      `# SpAIglass backend settings`,
      `PORT=8080`,
      `HOST=0.0.0.0`,
      ``,
    ].join("\n");

    c.header("Content-Type", "text/plain");
    c.header("Content-Disposition", `attachment; filename="connector-${connector.name}.env"`);
    return c.text(envContent);
  });

  return app;
}
