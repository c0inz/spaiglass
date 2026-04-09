/**
 * Agent API key management routes.
 * Allows programmatic VM registration without browser OAuth.
 */

import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { createAgentKey, getAgentKeysByUser, deleteAgentKey } from "./db.ts";
import { requireAuth } from "./middleware.ts";
import type { RelayEnv } from "./types.ts";

export function agentKeyRoutes(): Hono<RelayEnv> {
  const app = new Hono<RelayEnv>();

  app.use("/api/agent-keys/*", requireAuth());

  // Create a new agent key
  app.post("/api/agent-keys", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ name: string }>();

    if (!body.name || typeof body.name !== "string" || body.name.length > 100) {
      return c.json({ error: "Name is required (max 100 chars)" }, 400);
    }

    // Generate a random key: sg_<32 hex chars>
    const rawKey = randomBytes(32).toString("hex");
    const key = `sg_${rawKey}`;
    const keyHash = createHash("sha256").update(key).digest("hex");
    const prefix = `sg_${rawKey.slice(0, 8)}...`;

    const agentKey = createAgentKey(user.id, body.name.trim(), keyHash, prefix);

    return c.json({
      id: agentKey.id,
      name: agentKey.name,
      key, // Only shown once at creation
      prefix: agentKey.prefix,
      createdAt: agentKey.created_at,
    }, 201);
  });

  // List agent keys (without the actual key)
  app.get("/api/agent-keys", (c) => {
    const user = c.get("user")!;
    const keys = getAgentKeysByUser(user.id);
    return c.json(keys);
  });

  // Delete an agent key
  app.delete("/api/agent-keys/:id", (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const deleted = deleteAgentKey(id, user.id);
    if (!deleted) {
      return c.json({ error: "Key not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
