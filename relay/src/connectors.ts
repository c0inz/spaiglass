/**
 * Connector (VM) management routes.
 */

import { Hono } from "hono";
import {
  createConnector,
  getConnectorsByUser,
  getConnectorById,
  deleteConnector,
  getConnectorAccess,
  getSharedConnectorsForUser,
  listCollaborators,
  addCollaborator,
  removeCollaborator,
  updateCollaboratorRole,
  findUserByLogin,
  appendAuditLog,
  listAuditLog,
  getRoleLabels,
  setRoleLabel,
} from "./db.ts";
import { requireAuth } from "./middleware.ts";
import { getChannelManager } from "./tunnel.ts";
import type { RelayEnv } from "./types.ts";

export function connectorRoutes(): Hono<RelayEnv> {
  const app = new Hono<RelayEnv>();

  // All connector routes require auth
  app.use("/api/connectors/*", requireAuth());

  // List connectors with online/offline status.
  // Phase 2: response now includes both `owned` (this user is the owner) and
  // `shared` (this user is an explicit collaborator with editor/viewer role).
  app.get("/api/connectors", (c) => {
    const user = c.get("user")!;
    const connectors = getConnectorsByUser(user.id);
    const shared = getSharedConnectorsForUser(user.id);
    const cm = getChannelManager();

    const owned = connectors.map((conn) => ({
      id: conn.id,
      name: conn.name,
      role: "owner" as const,
      online: cm.isOnline(conn.id),
      lastSeen: conn.last_seen,
      createdAt: conn.created_at,
      // Spaiglass install version reported by the VM on its WS auth handshake.
      // Null when offline. Dashboard compares against LATEST_SPAIGLASS_VERSION.
      spaiglassVersion: cm.getVersion(conn.id),
    }));

    const sharedOut = shared.map((conn) => ({
      id: conn.id,
      name: conn.name,
      role: conn.role,
      ownerLogin: conn.owner_login,
      online: cm.isOnline(conn.id),
      lastSeen: conn.last_seen,
      createdAt: conn.created_at,
      spaiglassVersion: cm.getVersion(conn.id),
    }));

    // Backwards compat: legacy clients expect a flat array. Keep the flat
    // shape but add `role` and an optional `ownerLogin` so new clients can
    // filter into "Owned" vs "Shared with me" sections.
    return c.json([...owned, ...sharedOut]);
  });

  // Register a new connector
  app.post("/api/connectors", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ name: string }>();

    if (!body.name || typeof body.name !== "string" || body.name.length > 100) {
      return c.json({ error: "Name is required (max 100 chars)" }, 400);
    }

    const connector = createConnector(user.id, body.name.trim());
    const publicUrl = c.env.PUBLIC_URL;
    return c.json({
      id: connector.id,
      name: connector.name,
      token: connector.token,
      createdAt: connector.created_at,
      url: `${publicUrl}/vm/${user.github_login}.${connector.name}/`,
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
      `# Spaiglass VM Connector Configuration`,
      `# Generated for: ${connector.name}`,
      `# Relay: ${publicUrl}`,
      `# Source: https://github.com/c0inz/spaiglass (MIT License)`,
      `#`,
      `# SETUP INSTRUCTIONS (for humans and LLM agents):`,
      `#`,
      `# 1. Install prerequisites on the VM:`,
      `#      Node.js >= 20, npm, Claude Code CLI (npm install -g @anthropic-ai/claude-code && claude login)`,
      `#`,
      `# 2. Clone and install:`,
      `#      git clone https://github.com/c0inz/spaiglass.git /opt/spaiglass`,
      `#      cd /opt/spaiglass/frontend && npm install && npm run build`,
      `#      cd /opt/spaiglass/backend && npm install`,
      `#      ln -sf /opt/spaiglass/frontend/dist /opt/spaiglass/backend/static`,
      `#`,
      `# 3. Copy this file to /opt/spaiglass/backend/.env`,
      `#`,
      `# 4. Start the backend (local web UI + Claude Code bridge):`,
      `#      cd /opt/spaiglass/backend && npx tsx cli/node.ts --host 0.0.0.0 --port 8080`,
      `#`,
      `# 5. Start the relay connector (connects outbound to the relay):`,
      `#      cd /opt/spaiglass/backend && npx tsx connector.ts`,
      `#`,
      `#    Or run both with: cd /opt/spaiglass/backend && npx tsx cli/node.ts --host 0.0.0.0 --port 8080 & npx tsx connector.ts`,
      `#`,
      `# 6. Access this VM in the browser at:`,
      `#      ${publicUrl}/vm/${user.github_login}.${connector.name}/`,
      `#`,
      `# For full setup docs: curl ${publicUrl}/setup`,
      ``,
      `RELAY_URL=${publicUrl}`,
      `CONNECTOR_TOKEN=${connector.token}`,
      `CONNECTOR_ID=${connector.id}`,
      ``,
      `# Spaiglass backend settings`,
      `PORT=8080`,
      `HOST=0.0.0.0`,
      ``,
    ].join("\n");

    c.header("Content-Type", "text/plain");
    c.header("Content-Disposition", `attachment; filename="connector-${connector.name}.env"`);
    return c.text(envContent);
  });

  // --- Role labels (server-persisted) ---

  // Get all custom role labels for a connector.
  app.get("/api/connectors/:id/labels", (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const role = getConnectorAccess(id, user.id);
    if (!role) return c.json({ error: "Connector not found" }, 404);
    return c.json(getRoleLabels(id));
  });

  // Set or clear a role label. Owner only.
  app.put("/api/connectors/:id/labels", async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can edit labels" }, 403);
    }
    const body = await c.req.json<{
      projBase?: string;
      roleFile?: string;
      label?: string;
    }>();
    if (!body.projBase || !body.roleFile) {
      return c.json({ error: "projBase and roleFile are required" }, 400);
    }
    setRoleLabel(id, body.projBase, body.roleFile, body.label ?? null);
    return c.json({ ok: true });
  });

  // --- Phase 2: collaborator management routes ---

  // List collaborators on a VM. Owner OR any collaborator can see who else
  // has access (transparency — viewers should know who's watching with them).
  app.get("/api/connectors/:id/collaborators", (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const role = getConnectorAccess(id, user.id);
    if (!role) return c.json({ error: "Connector not found" }, 404);

    const owner = getConnectorById(id);
    if (!owner) return c.json({ error: "Connector not found" }, 404);

    const collabs = listCollaborators(id);
    return c.json({
      callerRole: role,
      collaborators: collabs.map((cb) => ({
        userId: cb.user_id,
        login: cb.github_login,
        name: cb.github_name,
        avatar: cb.github_avatar,
        role: cb.role,
        invitedBy: cb.invited_by,
        createdAt: cb.created_at,
      })),
    });
  });

  // Invite a collaborator by GitHub login. Owner only.
  app.post("/api/connectors/:id/collaborators", async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can manage collaborators" }, 403);
    }

    const body = await c.req.json<{ login?: string; role?: string }>();
    const targetLogin = (body.login || "").trim();
    const targetRole = body.role;

    if (!targetLogin) {
      return c.json({ error: "GitHub login is required" }, 400);
    }
    if (targetRole !== "editor" && targetRole !== "viewer") {
      return c.json({ error: "role must be 'editor' or 'viewer'" }, 400);
    }

    const target = findUserByLogin(targetLogin);
    if (!target) {
      // The target user must have signed in to spaiglass at least once so we
      // have a users row to FK against. Tell the caller to ask them to sign in.
      return c.json(
        {
          error: `User '${targetLogin}' has not signed in to spaiglass yet. Ask them to visit ${c.env.PUBLIC_URL} and sign in once.`,
        },
        404,
      );
    }

    if (target.id === user.id) {
      return c.json({ error: "You are already the owner" }, 400);
    }

    try {
      addCollaborator(id, target.id, targetRole, user.id);
    } catch (err) {
      // UNIQUE constraint — already a collaborator
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return c.json(
          { error: `${targetLogin} is already a collaborator. Use PATCH to change their role.` },
          409,
        );
      }
      return c.json({ error: message }, 500);
    }

    appendAuditLog(id, user.id, "collaborator_added", target.id, {
      role: targetRole,
      login: target.github_login,
    });

    return c.json(
      {
        userId: target.id,
        login: target.github_login,
        name: target.github_name,
        avatar: target.github_avatar,
        role: targetRole,
      },
      201,
    );
  });

  // Change a collaborator's role. Owner only.
  app.patch("/api/connectors/:id/collaborators/:userId", async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const targetUserId = c.req.param("userId");
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can manage collaborators" }, 403);
    }

    const body = await c.req.json<{ role?: string }>();
    if (body.role !== "editor" && body.role !== "viewer") {
      return c.json({ error: "role must be 'editor' or 'viewer'" }, 400);
    }

    const updated = updateCollaboratorRole(id, targetUserId, body.role);
    if (!updated) {
      return c.json({ error: "Collaborator not found" }, 404);
    }

    appendAuditLog(id, user.id, "collaborator_role_changed", targetUserId, {
      role: body.role,
    });

    return c.json({ ok: true });
  });

  // Remove a collaborator. Owner only.
  app.delete("/api/connectors/:id/collaborators/:userId", (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const targetUserId = c.req.param("userId");
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can manage collaborators" }, 403);
    }

    const removed = removeCollaborator(id, targetUserId);
    if (!removed) {
      return c.json({ error: "Collaborator not found" }, 404);
    }

    appendAuditLog(id, user.id, "collaborator_removed", targetUserId, null);
    return c.json({ ok: true });
  });

  // Audit log for a VM. Owner only — collaborators do not see the log.
  app.get("/api/connectors/:id/audit", (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can view the audit log" }, 403);
    }

    const entries = listAuditLog(id, 200);
    return c.json({
      entries: entries.map((e) => ({
        id: e.id,
        action: e.action,
        actorLogin: e.actor_login,
        targetLogin: e.target_login,
        details: e.details ? JSON.parse(e.details) : null,
        createdAt: e.created_at,
      })),
    });
  });

  return app;
}
