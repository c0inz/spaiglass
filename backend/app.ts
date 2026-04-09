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
import {
  handleConfigRequest,
  handleHealthRequest,
} from "./handlers/config.ts";
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
import { createAuthMiddleware } from "./middleware/auth.ts";
import { logger } from "./utils/logger.ts";
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

  // Static file serving (assets only — SPA fallback added separately via finalizeSpa)
  const serveStatic = runtime.createStaticFileMiddleware({
    root: config.staticPath,
  });
  app.use("/assets/*", serveStatic);

  return app;
}

/**
 * Add SPA fallback catch-all. Call this AFTER registering any WebSocket routes.
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
    } catch (error) {
      logger.app.error("Error serving index.html: {error}", { error });
      return c.text("Internal server error", 500);
    }
  });
}
