/**
 * SGCleanRelay — Stateless routing proxy for SpAIglass VM fleet.
 *
 * Routes browser WebSocket connections to private SpAIglass VMs.
 * GitHub OAuth for identity. No secrets, files, or conversations stored.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { getCookie } from "hono/cookie";
import { initDb, cleanExpiredSessions, getUserBySessionToken, getConnectorById } from "./db.ts";
import { authRoutes, SESSION_COOKIE } from "./auth.ts";
import { connectorRoutes } from "./connectors.ts";
import { agentKeyRoutes } from "./agent-keys.ts";
import { authMiddleware, rateLimit } from "./middleware.ts";
import { handleConnectorWs, createBrowserWsHandler, getChannelManager } from "./tunnel.ts";
import type { RelayEnv } from "./types.ts";

// --- Configuration ---

const PORT = parseInt(process.env.PORT || "4000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const DB_PATH = process.env.DB_PATH || "./relay.db";

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.warn("WARNING: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET not set. OAuth will not work.");
}

// --- Initialize ---

initDb(DB_PATH);

const app = new Hono<RelayEnv>();

// Inject environment bindings
app.use("*", async (c, next) => {
  c.env = {
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    PUBLIC_URL,
    SESSION_SECRET: process.env.SESSION_SECRET || "dev-secret",
  };
  await next();
});

// CORS
app.use("*", cors({
  origin: PUBLIC_URL,
  credentials: true,
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// Rate limiting
app.use("/auth/*", rateLimit(20, 60_000)); // 20/min for auth
app.use("/api/*", rateLimit(100, 60_000)); // 100/min for API

// Auth middleware (sets user, doesn't reject)
app.use("*", authMiddleware());

// --- Routes ---

// Health check (before auth-required routes)
app.get("/api/health", (c) => {
  const cm = getChannelManager();
  const stats = cm.stats();
  return c.json({
    status: "ok",
    version: "0.1.0",
    connectors: stats.connectors,
    browsers: stats.browsers,
  });
});

// Setup page (machine-readable for Claude agents)
app.get("/setup", (c) => {
  const user = c.get("user");
  return c.json({
    relay: PUBLIC_URL,
    authenticated: !!user,
    user: user ? { login: user.github_login } : null,
    instructions: {
      step1: "Sign in with GitHub at /auth/github",
      step2: "Create a connector via POST /api/connectors with { name: 'my-vm' }",
      step3: "Download the connector config from GET /api/connectors/:id/config",
      step4: "On the VM, set RELAY_URL and CONNECTOR_TOKEN from the config",
      step5: "Start the SpAIglass backend — it will connect to the relay",
      step6: "Access the VM at /vm/:connectorId/ in your browser",
    },
    agenticSetup: {
      description: "For automated VM enrollment, create an agent key and use Bearer auth",
      createKey: "POST /api/agent-keys with { name: 'agent' } — returns a key shown once",
      registerVm: "POST /api/connectors with { name: 'vm-name' } using Bearer key",
      downloadConfig: "GET /api/connectors/:id/config — returns .env for the VM",
    },
  });
});

// Terms of Service
app.get("/terms", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Terms of Service - SpAIglass</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 700px; margin: 60px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; line-height: 1.6; }
  h1 { font-size: 1.8em; }
  h2 { font-size: 1.2em; margin-top: 28px; }
  a { color: #3b82f6; }
  .updated { color: #666; font-size: 0.9em; }
</style>
</head><body>
<h1>Terms of Service</h1>
<p class="updated">Last updated: April 9, 2026</p>

<h2>1. Service Description</h2>
<p>SpAIglass ("the Service") is a fleet gateway that routes browser connections to your virtual machines through a relay server. The Service is operated by ReadyStack.dev.</p>

<h2>2. Eligibility</h2>
<p>You must have a valid GitHub account to use the Service. By signing in, you agree to these terms.</p>

<h2>3. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>Use the Service for any unlawful purpose</li>
  <li>Attempt to gain unauthorized access to other users' VMs or data</li>
  <li>Interfere with or disrupt the Service infrastructure</li>
  <li>Reverse engineer or probe the relay beyond documented APIs</li>
</ul>

<h2>4. Your VMs and Data</h2>
<p>You are solely responsible for the content and activity on VMs you connect through the Service. The relay routes traffic but does not store, inspect, or modify your VM sessions.</p>

<h2>5. Availability</h2>
<p>The Service is provided "as is" without warranty. We do not guarantee uptime or availability and may modify or discontinue the Service at any time.</p>

<h2>6. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, ReadyStack.dev shall not be liable for any indirect, incidental, or consequential damages arising from your use of the Service.</p>

<h2>7. Termination</h2>
<p>We may suspend or terminate your access at any time for violation of these terms. You may stop using the Service at any time.</p>

<h2>8. Changes</h2>
<p>We may update these terms. Continued use after changes constitutes acceptance.</p>

<p><a href="/">&larr; Back to SpAIglass</a></p>
</body></html>`);
});

// Privacy Policy
app.get("/privacy", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Privacy Policy - SpAIglass</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 700px; margin: 60px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; line-height: 1.6; }
  h1 { font-size: 1.8em; }
  h2 { font-size: 1.2em; margin-top: 28px; }
  a { color: #3b82f6; }
  .updated { color: #666; font-size: 0.9em; }
</style>
</head><body>
<h1>Privacy Policy</h1>
<p class="updated">Last updated: April 9, 2026</p>

<h2>1. What We Collect</h2>
<p>When you sign in with GitHub, we store:</p>
<ul>
  <li><strong>GitHub profile info:</strong> username, display name, avatar URL, and GitHub user ID</li>
  <li><strong>Session tokens:</strong> random tokens used to keep you signed in</li>
  <li><strong>Connector records:</strong> names and tokens for VMs you register</li>
  <li><strong>Agent API keys:</strong> stored as hashed values only</li>
</ul>

<h2>2. What We Do NOT Collect</h2>
<ul>
  <li>We do not store, log, or inspect any traffic between your browser and your VMs</li>
  <li>We do not store your GitHub password or OAuth tokens long-term</li>
  <li>We do not use cookies for tracking or analytics</li>
  <li>We do not sell or share your data with third parties</li>
</ul>

<h2>3. How Data Flows</h2>
<p>The relay acts as a stateless routing proxy. Browser-to-VM WebSocket traffic passes through the relay in real time and is not stored. The relay only persists the minimal metadata needed to authenticate you and route connections to the correct VM.</p>

<h2>4. Data Storage</h2>
<p>All data is stored in a SQLite database on the relay server. Session tokens expire automatically and are cleaned up periodically.</p>

<h2>5. Data Deletion</h2>
<p>You can delete your connectors and agent keys from the dashboard at any time. To request full account deletion, contact us and we will remove all associated records.</p>

<h2>6. Third-Party Services</h2>
<p>We use GitHub OAuth for authentication. GitHub's privacy policy applies to data they collect during the sign-in process. We use Cloudflare for DNS and Caddy for TLS — standard infrastructure that does not process your VM traffic.</p>

<h2>7. Changes</h2>
<p>We may update this policy. Material changes will be noted on this page with an updated date.</p>

<p><a href="/">&larr; Back to SpAIglass</a></p>
</body></html>`);
});

// Auth routes
app.route("/", authRoutes());

// Connector management (has its own requireAuth)
app.route("/", connectorRoutes());

// Agent key management (has its own requireAuth)
app.route("/", agentKeyRoutes());

// Dashboard (simple HTML)
app.get("/", (c) => {
  const user = c.get("user");
  if (!user) {
    return c.html(`<!DOCTYPE html>
<html><head><title>SpAIglass Relay</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; }
  h1 { font-size: 2em; }
  a.btn { display: inline-block; padding: 12px 24px; background: #24292e; color: white; text-decoration: none; border-radius: 8px; font-size: 1.1em; }
  a.btn:hover { background: #444d56; }
  .subtitle { color: #666; margin-top: -10px; }
</style>
</head><body>
<h1>SpAIglass Relay</h1>
<p class="subtitle">Fleet gateway for SpAIglass VMs</p>
<p>Sign in with GitHub to manage your VM fleet.</p>
<a class="btn" href="/auth/github">Sign in with GitHub</a>
<div style="margin-top: 40px; font-size: 0.85em; color: #999;"><a href="/terms" style="color: #999;">Terms</a> &middot; <a href="/privacy" style="color: #999;">Privacy</a></div>
</body></html>`);
  }

  return c.html(`<!DOCTYPE html>
<html><head><title>SpAIglass Fleet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; }
  h1 { font-size: 1.8em; }
  .user { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .user img { width: 40px; height: 40px; border-radius: 50%; }
  .card { background: white; border-radius: 8px; padding: 16px; margin: 12px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .online { color: #22c55e; font-weight: bold; }
  .offline { color: #94a3b8; }
  button { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-danger { background: #ef4444; color: white; }
  .btn-secondary { background: #e2e8f0; color: #475569; }
  input { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.9em; }
  #connectors { margin-top: 20px; }
  .actions { margin-top: 12px; display: flex; gap: 8px; }
  pre { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85em; }
</style>
</head><body>
<div class="user">
  <img src="${user.github_avatar}" alt="${user.github_login}">
  <div>
    <strong>${user.github_name || user.github_login}</strong>
    <div style="font-size: 0.85em; color: #666;">@${user.github_login}</div>
  </div>
  <button class="btn-secondary" onclick="logout()" style="margin-left: auto;">Sign out</button>
</div>

<h1>Your Fleet</h1>

<div style="display: flex; gap: 8px; align-items: center;">
  <input id="vmName" placeholder="VM name (e.g. dev-server)" />
  <button class="btn-primary" onclick="addConnector()">Register VM</button>
</div>

<div id="connectors"></div>

<h2>Setup Guide</h2>
<div class="card">
  <p><strong>1.</strong> Register a VM above — you'll get a connector token.</p>
  <p><strong>2.</strong> On the VM, download the config or set these env vars:</p>
  <pre>RELAY_URL=${PUBLIC_URL}
CONNECTOR_TOKEN=&lt;from registration&gt;</pre>
  <p><strong>3.</strong> Start SpAIglass backend — it connects to the relay automatically.</p>
  <p><strong>4.</strong> Access your VM at <code>${PUBLIC_URL}/vm/&lt;connectorId&gt;/</code></p>
</div>

<script>
async function loadConnectors() {
  const res = await fetch('/api/connectors');
  const data = await res.json();
  const el = document.getElementById('connectors');
  if (data.length === 0) {
    el.innerHTML = '<div class="card" style="color: #94a3b8;">No VMs registered yet. Add one above.</div>';
    return;
  }
  el.innerHTML = data.map(c => \`
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>\${c.name}</strong>
        <span class="\${c.online ? 'online' : 'offline'}">\${c.online ? 'Online' : 'Offline'}</span>
      </div>
      <div style="font-size: 0.85em; color: #666; margin-top: 4px;">ID: \${c.id}</div>
      <div class="actions">
        \${c.online ? \`<button class="btn-primary" onclick="window.open('/vm/\${c.id}/')">Open</button>\` : ''}
        <a href="/api/connectors/\${c.id}/config" class="btn-secondary" style="text-decoration: none; padding: 8px 16px; border-radius: 6px;">Download Config</a>
        <button class="btn-danger" onclick="deleteConnector('\${c.id}')">Delete</button>
      </div>
    </div>
  \`).join('');
}

async function addConnector() {
  const name = document.getElementById('vmName').value.trim();
  if (!name) return alert('Enter a VM name');
  const res = await fetch('/api/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (data.token) {
    alert('Connector created!\\n\\nToken (save this — shown only once):\\n' + data.token);
  }
  document.getElementById('vmName').value = '';
  loadConnectors();
}

async function deleteConnector(id) {
  if (!confirm('Delete this connector?')) return;
  await fetch('/api/connectors/' + id, { method: 'DELETE' });
  loadConnectors();
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  location.reload();
}

loadConnectors();
setInterval(loadConnectors, 10000);
</script>
<div style="margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 0.85em; color: #999;"><a href="/terms" style="color: #999;">Terms</a> &middot; <a href="/privacy" style="color: #999;">Privacy</a></div>
</body></html>`);
});

// --- WebSocket Setup ---

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// VM connector WebSocket
const connectorHandler = handleConnectorWs();
app.get("/connector", upgradeWebSocket(() => ({
  onMessage(event, ws) { connectorHandler.onMessage(ws, event); },
  onClose(_event, ws) { connectorHandler.onClose(ws); },
  onError(_event, ws) { connectorHandler.onError(ws); },
})));

// Browser → VM WebSocket tunnel
app.get("/vm/:connectorId/ws", upgradeWebSocket((c) => {
  const connectorId = c.req.param("connectorId")!;
  const sessionToken = getCookie(c, SESSION_COOKIE);

  // Must be authenticated
  const user = sessionToken ? getUserBySessionToken(sessionToken) : undefined;
  if (!user) {
    return {
      onOpen(_event, ws) {
        ws.send(JSON.stringify({ type: "error", message: "Authentication required" }));
        ws.close();
      },
    };
  }

  // Validate ownership
  const connector = getConnectorById(connectorId);
  if (!connector || connector.user_id !== user.id) {
    return {
      onOpen(_event, ws) {
        ws.send(JSON.stringify({ type: "error", message: "Connector not found" }));
        ws.close();
      },
    };
  }

  const handler = createBrowserWsHandler(connectorId!, user.id);
  return {
    onOpen(event, ws) { handler.onOpen(ws); },
    onMessage(event, ws) { handler.onMessage(ws, event); },
    onClose() { handler.onClose(); },
    onError() { handler.onError(); },
  };
}));

// --- Start Server ---

console.log(`SGCleanRelay starting on ${HOST}:${PORT}`);
console.log(`Public URL: ${PUBLIC_URL}`);

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
injectWebSocket(server);

// Session cleanup every hour
setInterval(() => {
  const cleaned = cleanExpiredSessions();
  if (cleaned > 0) console.log(`Cleaned ${cleaned} expired sessions`);
}, 60 * 60 * 1000);

console.log("SGCleanRelay ready.");
