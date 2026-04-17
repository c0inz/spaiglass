/**
 * Runtime-agnostic Hono application
 *
 * This module creates the Hono application with all routes and middleware,
 * but doesn't include runtime-specific code like CLI parsing or server startup.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Runtime } from "./runtime/types.ts";
import {
  type ConfigContext,
  createConfigMiddleware,
} from "./middleware/config.ts";
import { handleProjectsRequest } from "./handlers/projects.ts";
import { handleHistoriesRequest } from "./handlers/histories.ts";
import { handleConversationRequest } from "./handlers/conversations.ts";
import { handleChatRequest } from "./handlers/chat.ts";
import { handleAbortRequest } from "./handlers/abort.ts";
import { handleConfigRequest, handleHealthRequest } from "./handlers/config.ts";
import {
  handleFileTreeRequest,
  handleFileReadRequest,
  handleFileWriteRequest,
  handleFileSnapshotRequest,
  handleFileListRequest,
} from "./handlers/files.ts";
import { handleContextsRequest } from "./handlers/contexts.ts";
import { handleDiscoverRequest } from "./handlers/discover.ts";
import { handleStaleCheckRequest } from "./handlers/stale.ts";
import { handleUploadRequest } from "./handlers/upload.ts";
import {
  handleSessionSaveRequest,
  handleSessionLastRequest,
} from "./handlers/session.ts";
import {
  handleGetAnthropicKey,
  handleSetAnthropicKey,
} from "./handlers/settings.ts";
import {
  handleListSecrets,
  handlePutSecret,
  handleDeleteSecret,
} from "./handlers/secrets.ts";
import {
  handleGetPlugins,
  handleGetRoles,
  handleCreateRole,
  handleUpdateRole,
} from "./handlers/roles.ts";
import { handleRegisterProject } from "./handlers/register.ts";
import {
  handleGetProjectDisplayNames,
  handleSetProjectDisplayName,
} from "./handlers/project-display-names.ts";
import { createAuthMiddleware } from "./middleware/auth.ts";
import { readBinaryFile } from "./utils/fs.ts";

export interface AppConfig {
  debugMode: boolean;
  staticPath: string;
  cliPath: string; // Actual CLI script path detected by validateClaudeCli
}

export function createApp(
  runtime: Runtime,
  config: AppConfig,
): Hono<ConfigContext> {
  const app = new Hono<ConfigContext>();

  // Store AbortControllers for each request (shared with chat handler)
  const requestAbortControllers = new Map<string, AbortController>();

  // CORS middleware
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  // Configuration middleware - makes app settings available to all handlers
  app.use(
    "*",
    createConfigMiddleware({
      debugMode: config.debugMode,
      runtime,
      cliPath: config.cliPath,
    }),
  );

  // Health endpoint (before auth — allows portal to check status)
  app.get("/api/health", (c) => handleHealthRequest(c));

  // Auth middleware — protects all routes below this point
  app.use("*", createAuthMiddleware());

  // API routes
  app.get("/api/config", (c) => handleConfigRequest(c));
  app.get("/api/projects", (c) => handleProjectsRequest(c));

  app.get("/api/projects/:encodedProjectName/histories", (c) =>
    handleHistoriesRequest(c),
  );

  app.get("/api/projects/:encodedProjectName/histories/:sessionId", (c) =>
    handleConversationRequest(c),
  );

  app.post("/api/abort/:requestId", (c) =>
    handleAbortRequest(c, requestAbortControllers),
  );

  app.post("/api/chat", (c) => handleChatRequest(c, requestAbortControllers));

  // File browser routes
  app.get("/api/files/tree", (c) => handleFileTreeRequest(c));
  app.get("/api/files/read", (c) => handleFileReadRequest(c));
  app.post("/api/files/write", (c) => handleFileWriteRequest(c));
  app.get("/api/files/snapshot", (c) => handleFileSnapshotRequest(c));
  app.get("/api/files/list", (c) => handleFileListRequest(c));

  // Context selector
  app.get("/api/projects/contexts", (c) => handleContextsRequest(c));

  // Discovery endpoint
  app.get("/api/discover", (c) => handleDiscoverRequest(c));

  // Stale context detection
  app.post("/api/session/stale", (c) => handleStaleCheckRequest(c));

  // Image upload
  app.post("/api/upload", (c) => handleUploadRequest(c));

  // Session persistence
  app.post("/api/session/save", (c) => handleSessionSaveRequest(c));
  app.get("/api/session/last", (c) => handleSessionLastRequest(c));

  // Phase 4: BYO Anthropic API key — host-local, never proxied through relay
  app.get("/api/settings/anthropic-key", (c) => handleGetAnthropicKey(c));
  app.post("/api/settings/anthropic-key", (c) => handleSetAnthropicKey(c));

  // Secrets vault — named secrets stored in ~/.spaiglass/secrets.json
  app.get("/api/secrets", (c) => handleListSecrets(c));
  app.put("/api/secrets/:name", (c) => handlePutSecret(c));
  app.delete("/api/secrets/:name", (c) => handleDeleteSecret(c));

  // Plugins & roles
  app.get("/api/plugins", (c) => handleGetPlugins(c));
  app.get("/api/roles", (c) => handleGetRoles(c));
  app.post("/api/roles", (c) => handleCreateRole(c));
  app.put("/api/roles/:name", (c) => handleUpdateRole(c));

  // Project registration — one-shot create project + role + register with Claude
  app.post("/api/projects/register", (c) => handleRegisterProject(c));

  // Project display names — cosmetic labels for the UI
  app.get("/api/settings/project-display-names", (c) =>
    handleGetProjectDisplayNames(c),
  );
  app.put("/api/settings/project-display-name", (c) =>
    handleSetProjectDisplayName(c),
  );

  // Static file serving (assets only — SPA fallback added separately via finalizeSpa)
  const serveStatic = runtime.createStaticFileMiddleware({
    root: config.staticPath,
  });
  app.use("/assets/*", serveStatic);

  return app;
}

/**
 * Add SPA fallback catch-all. Call this AFTER registering any WebSocket routes.
 *
 * If the local static bundle is missing, the backend assumes the relay is
 * serving the frontend (the new architecture as of 2026.04.10). We return a
 * small placeholder page rather than crashing — direct LAN access keeps
 * working enough to surface a hint, and relay traffic never lands here in
 * the first place because the relay short-circuits HTML/asset requests.
 */
export function finalizeSpa(app: Hono<ConfigContext>, staticPath: string) {
  app.get("*", async (c) => {
    const path = c.req.path;

    if (path.startsWith("/api/")) {
      return c.notFound();
    }

    try {
      const indexPath = `${staticPath}/index.html`;
      const indexFile = await readBinaryFile(indexPath);
      return c.html(new TextDecoder().decode(indexFile));
    } catch {
      // No local frontend bundle — direct LAN visitor. Point them at the relay.
      return c.html(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SpAIglass VM</title>` +
          `<style>body{font-family:system-ui;max-width:560px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;line-height:1.5}h1{margin-bottom:.4em}code{background:#e4e4ec;padding:2px 6px;border-radius:4px}</style>` +
          `</head><body><h1>SpAIglass VM backend</h1>` +
          `<p>This VM ships its API only. The frontend is served by the relay.</p>` +
          `<p>Open <a href="https://spaiglass.xyz/fleetrelay">spaiglass.xyz/fleetrelay</a> and pick this VM from the dashboard.</p>` +
          `<p style="color:#555;font-size:.9em">If you reached this page directly via the VM's LAN address, that's expected — direct LAN access still works for the API (<code>/api/*</code>) but the UI now lives on the relay.</p>` +
          `</body></html>`,
        200,
      );
    }
  });
}
