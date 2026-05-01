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
  updateConnectorDisplayName,
  updateConnectorName,
  connectorDisplayName,
  findUserByLogin,
  appendAuditLog,
  listAuditLog,
  getRoleLabels,
  setRoleLabel,
} from "./db.ts";
import { requireAuth } from "./middleware.ts";
import { getChannelManager } from "./tunnel.ts";
import type { RelayEnv } from "./types.ts";
import {
  validateConnectorName,
  validateDisplayName,
  validateUuidParam,
  parseJsonBody,
  rejectUnknownKeys,
} from "./validation.ts";

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
      displayName: connectorDisplayName(conn),
      role: "owner" as const,
      online: cm.isOnline(conn.id),
      lastSeen: conn.last_seen,
      createdAt: conn.created_at,
      spaiglassVersion: cm.getVersion(conn.id),
    }));

    const sharedOut = shared.map((conn) => ({
      id: conn.id,
      name: conn.name,
      displayName: connectorDisplayName(conn),
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
    const parsed = await parseJsonBody(c.req);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const reject = rejectUnknownKeys(parsed.body, ["name"]);
    if (reject) return c.json({ error: reject.error }, reject.status);

    const nameCheck = validateConnectorName(parsed.body.name);
    if (!nameCheck.ok) return c.json({ error: nameCheck.error }, nameCheck.status);

    // Reject duplicates up-front — the unique-per-user check saves a round-
    // trip for an agent that forgets to list existing connectors first.
    const existing = getConnectorsByUser(user.id).find(
      (conn) => conn.name.toLowerCase() === nameCheck.value.toLowerCase(),
    );
    if (existing) {
      return c.json(
        {
          error: `You already have a connector named '${nameCheck.value}' (id: ${existing.id}). Use it instead of creating a duplicate, or PATCH it to rename.`,
          existingId: existing.id,
        },
        409,
      );
    }

    const connector = createConnector(user.id, nameCheck.value);
    // rawToken is the plaintext token shown once — the DB stores only the hash
    return c.json({
      id: connector.id,
      name: connector.name,
      displayName: connectorDisplayName(connector),
      token: connector.rawToken,
      createdAt: connector.created_at,
    }, 201);
  });

  // Delete a connector
  app.delete("/api/connectors/:id", (c) => {
    const user = c.get("user")!;
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);

    const deleted = deleteConnector(idCheck.value, user.id);
    if (!deleted) {
      return c.json({ error: "Connector not found" }, 404);
    }
    // Disconnect if online
    getChannelManager().disconnect(idCheck.value);
    return c.json({ ok: true });
  });

  // Update connector. Owner only.
  // Accepts `displayName` (free-form label) and/or `name` (slug; URL identity).
  // Renaming preserves the connector id + token so the VM-side connector keeps
  // working — the customer agent does not need to reconfigure the .env.
  app.patch("/api/connectors/:id", async (c) => {
    const user = c.get("user")!;
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const id = idCheck.value;

    const parsed = await parseJsonBody(c.req);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    const reject = rejectUnknownKeys(body, ["displayName", "name"]);
    if (reject) return c.json({ error: reject.error }, reject.status);

    if (!("displayName" in body) && !("name" in body)) {
      return c.json({ error: "At least one of {displayName, name} required" }, 400);
    }

    // Slug rename (identity — changes /vm/<login>.<name>/ URL). Same rules as create.
    if ("name" in body) {
      const nameCheck = validateConnectorName(body.name);
      if (!nameCheck.ok) return c.json({ error: nameCheck.error }, nameCheck.status);
      const result = updateConnectorName(id, user.id, nameCheck.value);
      if (result === "not_found") return c.json({ error: "Connector not found" }, 404);
      if (result === "conflict")
        return c.json({ error: `You already have a connector named '${nameCheck.value}'` }, 409);
    }

    // Display-name update (free-form, URL-irrelevant).
    if ("displayName" in body) {
      const dnCheck = validateDisplayName(body.displayName);
      if (!dnCheck.ok) return c.json({ error: dnCheck.error }, dnCheck.status);
      const ok = updateConnectorDisplayName(id, user.id, dnCheck.value);
      if (!ok) return c.json({ error: "Connector not found" }, 404);
    }

    const fresh = getConnectorById(id);
    if (!fresh) return c.json({ error: "Connector not found" }, 404);
    return c.json({
      ok: true,
      id,
      name: fresh.name,
      displayName: connectorDisplayName(fresh),
    });
  });

  // Download .env config for a connector.
  // The connector token is hashed at rest — the raw token was shown once at
  // creation time. This config omits the token; the user must supply it from
  // their records or delete + recreate the connector to get a new one.
  app.get("/api/connectors/:id/config", (c) => {
    const user = c.get("user")!;
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const connector = getConnectorById(idCheck.value);

    if (!connector || connector.user_id !== user.id) {
      return c.json({ error: "Connector not found" }, 404);
    }

    const publicUrl = c.env.PUBLIC_URL;
    const envContent = [
      `# SpAIglass VM Connector Configuration`,
      `# Generated for: ${connector.name}`,
      `# Relay: ${publicUrl}`,
      `# Source: https://github.com/c0inz/spaiglass (MIT License)`,
      `#`,
      `# SECURITY NOTE: The connector token is hashed at rest on the relay.`,
      `# The raw token was shown once when the connector was created.`,
      `# If you lost it, delete this connector and create a new one.`,
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
      `# 3. Copy this file to /opt/spaiglass/backend/.env and fill in your token`,
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
      `CONNECTOR_TOKEN=<paste your token here>`,
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

  // --- Role labels (server-persisted) ---

  // Get all custom role labels for a connector.
  app.get("/api/connectors/:id/labels", (c) => {
    const user = c.get("user")!;
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const role = getConnectorAccess(idCheck.value, user.id);
    if (!role) return c.json({ error: "Connector not found" }, 404);
    return c.json(getRoleLabels(idCheck.value));
  });

  // Set or clear a role label. Owner only.
  app.put("/api/connectors/:id/labels", async (c) => {
    const user = c.get("user")!;
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const id = idCheck.value;
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can edit labels" }, 403);
    }
    const parsed = await parseJsonBody(c.req);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const reject = rejectUnknownKeys(parsed.body, ["projBase", "roleFile", "label"]);
    if (reject) return c.json({ error: reject.error }, reject.status);
    const body = parsed.body as { projBase?: unknown; roleFile?: unknown; label?: unknown };
    if (typeof body.projBase !== "string" || !body.projBase.trim()) {
      return c.json({ error: "projBase is required (string)" }, 400);
    }
    if (typeof body.roleFile !== "string" || !body.roleFile.trim()) {
      return c.json({ error: "roleFile is required (string)" }, 400);
    }
    const label =
      body.label === null || body.label === undefined
        ? null
        : typeof body.label === "string"
          ? body.label
          : undefined;
    if (label === undefined) {
      return c.json({ error: "label must be a string or null" }, 400);
    }
    if (label && label.length > 200) {
      return c.json({ error: "label max 200 chars" }, 400);
    }
    setRoleLabel(id, body.projBase.trim(), body.roleFile.trim(), label);
    return c.json({ ok: true });
  });

  // --- Phase 2: collaborator management routes ---

  // List collaborators on a VM. Owner OR any collaborator can see who else
  // has access (transparency — viewers should know who's watching with them).
  app.get("/api/connectors/:id/collaborators", (c) => {
    const user = c.get("user")!;
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const id = idCheck.value;
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
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const id = idCheck.value;
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can manage collaborators" }, 403);
    }

    const parsed = await parseJsonBody(c.req);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const reject = rejectUnknownKeys(parsed.body, ["login", "role"]);
    if (reject) return c.json({ error: reject.error }, reject.status);
    const body = parsed.body as { login?: unknown; role?: unknown };
    const targetLogin = typeof body.login === "string" ? body.login.trim() : "";
    const targetRole = body.role;

    if (!targetLogin) {
      return c.json({ error: "GitHub login is required (string)" }, 400);
    }
    // GitHub logins: alphanumeric and single hyphens, max 39 chars — the
    // cheapest way to reject SQL-ish junk before we hit findUserByLogin.
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(targetLogin)) {
      return c.json({ error: "GitHub login has invalid format" }, 400);
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
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const userIdCheck = validateUuidParam(c.req.param("userId"));
    if (!userIdCheck.ok) return c.json({ error: userIdCheck.error }, userIdCheck.status);
    const id = idCheck.value;
    const targetUserId = userIdCheck.value;
    const role = getConnectorAccess(id, user.id);
    if (role !== "owner") {
      return c.json({ error: "Only the owner can manage collaborators" }, 403);
    }

    const parsed = await parseJsonBody(c.req);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const reject = rejectUnknownKeys(parsed.body, ["role"]);
    if (reject) return c.json({ error: reject.error }, reject.status);
    const body = parsed.body as { role?: unknown };
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
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const userIdCheck = validateUuidParam(c.req.param("userId"));
    if (!userIdCheck.ok) return c.json({ error: userIdCheck.error }, userIdCheck.status);
    const id = idCheck.value;
    const targetUserId = userIdCheck.value;
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
    const idCheck = validateUuidParam(c.req.param("id"));
    if (!idCheck.ok) return c.json({ error: idCheck.error }, idCheck.status);
    const id = idCheck.value;
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
