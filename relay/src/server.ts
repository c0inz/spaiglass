/**
 * SGCleanRelay — Stateless routing proxy for SpAIglass VM fleet.
 *
 * Routes browser WebSocket connections to private SpAIglass VMs.
 * GitHub OAuth for identity. No secrets, files, or conversations stored.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { getCookie } from "hono/cookie";
import { initDb, cleanExpiredSessions, getUserBySessionToken, getConnectorById, getConnectorBySlug } from "./db.ts";
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

// --- Shared HTML helpers ---

// Inline SVG favicon — spyglass/eye icon in brand blue
const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="28" cy="28" r="18" fill="none" stroke="#3b82f6" stroke-width="5"/><circle cx="28" cy="28" r="7" fill="#3b82f6"/><line x1="42" y1="42" x2="58" y2="58" stroke="#3b82f6" stroke-width="5" stroke-linecap="round"/></svg>')}" />`;

// --- Initialize ---

initDb(DB_PATH);

const app = new Hono<RelayEnv>();

// Inject environment bindings (mutate, don't replace — preserves WS upgrade symbol refs)
app.use("*", async (c, next) => {
  Object.assign(c.env, {
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    PUBLIC_URL,
    SESSION_SECRET: process.env.SESSION_SECRET || "dev-secret",
  });
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
    project: "SpAIglass",
    description: "Browser-based multi-VM interface for Claude Code. SpAIglass is a custom relay service that routes browser WebSocket connections to Claude Code running on remote VMs.",
    license: "MIT",
    source: "https://github.com/c0inz/spaiglass",
    relay: PUBLIC_URL,
    authenticated: !!user,
    user: user ? { login: user.github_login } : null,

    // --- COMPLETE ZERO-HUMAN ENROLLMENT FLOW ---
    // An LLM agent or script can follow these steps in order to set up
    // a VM with no human interaction at any point.
    agenticFlow: {
      summary: "Complete flow to enroll a VM with zero human interaction. Follow steps 1-6 in order.",
      step1_authenticate: {
        description: "Exchange a GitHub PAT for a SpAIglass agent key. The PAT proves your GitHub identity. The agent key is used for all subsequent API calls.",
        endpoint: "POST " + PUBLIC_URL + "/api/auth/token-exchange",
        headers: { "Content-Type": "application/json" },
        body: { github_pat: "ghp_YOUR_TOKEN", key_name: "my-agent" },
        returns: "{ user: { login }, agent_key: 'sg_...', key_id, key_prefix }",
        note: "Save the agent_key — it is shown only once. If you already have an agent key, skip this step.",
      },
      step2_register_vm: {
        description: "Register a new VM connector. The name is a label for your reference — it does not need to match hostname or IP.",
        endpoint: "POST " + PUBLIC_URL + "/api/connectors",
        headers: { "Authorization": "Bearer sg_YOUR_KEY", "Content-Type": "application/json" },
        body: { name: "my-vm" },
        returns: "{ id, name, token, createdAt }",
      },
      step3_download_config: {
        description: "Download the connector .env config file. It contains the relay URL, connector token, connector ID, and full install instructions in comments.",
        endpoint: "GET " + PUBLIC_URL + "/api/connectors/:id/config",
        headers: { "Authorization": "Bearer sg_YOUR_KEY" },
        returns: "Plain text .env file — save it to disk",
      },
      step4_install: {
        description: "Clone the repo, build the frontend, and install backend dependencies on the VM.",
        requirements: ["Node.js >= 20", "npm", "Claude Code CLI installed and authenticated (npm install -g @anthropic-ai/claude-code && claude login)"],
        commands: [
          "git clone https://github.com/c0inz/spaiglass.git /opt/spaiglass",
          "cd /opt/spaiglass/frontend && npm install && npm run build",
          "cd /opt/spaiglass/backend && npm install",
          "ln -sf /opt/spaiglass/frontend/dist /opt/spaiglass/backend/static",
          "cp /path/to/connector.env /opt/spaiglass/backend/.env",
        ],
        notes: [
          "The frontend build produces static files in frontend/dist/",
          "The symlink makes the backend serve the frontend UI",
          "The .env file goes in the backend/ directory",
        ],
      },
      step5_start: {
        description: "Start two processes: the backend (local web UI + Claude Code bridge) and the connector client (outbound WebSocket to relay). Both read from the same .env file.",
        backend: "cd /opt/spaiglass/backend && npx tsx cli/node.ts --host 0.0.0.0 --port 8080",
        connector: "cd /opt/spaiglass/backend && npx tsx connector.ts",
        combined: "cd /opt/spaiglass/backend && npx tsx cli/node.ts --host 0.0.0.0 --port 8080 & npx tsx connector.ts",
        notes: [
          "The backend serves the web UI and bridges to Claude Code CLI locally",
          "The connector client connects OUTBOUND to the relay and multiplexes browser sessions to the local backend's /api/ws WebSocket endpoint",
          "No inbound ports or firewall changes needed — all relay traffic is outbound",
          "Both processes must be running for relay access to work",
        ],
      },
      step6_report_url: {
        description: "Tell the user their VM is live. The URL uses their GitHub login and VM name from step 2.",
        userUrl: PUBLIC_URL + "/vm/<githubLogin>.<vmName>/",
        example: PUBLIC_URL + "/vm/octocat.dev-server/",
        note: "The slug is case-insensitive. You can also append project/role for bookmarkable URLs: /vm/<login>.<vm>/<project>/<role>/",
      },
    },

    // --- ADDING MORE VMs TO THE SAME ACCOUNT ---
    addMoreVms: {
      description: "The agent key is reusable across all VMs for the same user account. To add another VM, repeat steps 2-6 with the same agent key. No re-authentication needed.",
      steps: [
        "POST /api/connectors with a new name and the same agent key — each VM gets its own connector ID and token",
        "GET /api/connectors/:id/config to download that VM's config",
        "Install and start the connector on the new VM",
        "Report the new URL to the user: " + PUBLIC_URL + "/vm/<githubLogin>.<vmName>/",
      ],
      createMoreKeys: {
        description: "An agent key can also create additional agent keys for other agents or automation systems.",
        endpoint: "POST " + PUBLIC_URL + "/api/agent-keys",
        headers: { "Authorization": "Bearer sg_YOUR_KEY", "Content-Type": "application/json" },
        body: { name: "another-agent" },
      },
      listVms: {
        description: "List all VMs registered to your account.",
        endpoint: "GET " + PUBLIC_URL + "/api/connectors",
        headers: { "Authorization": "Bearer sg_YOUR_KEY" },
      },
    },

    // --- ALTERNATIVE: BROWSER ENROLLMENT ---
    browserFlow: {
      description: "If a human is available, they can sign in via browser and manage everything from the dashboard.",
      step1: "Open " + PUBLIC_URL + "/auth/github in a browser and sign in with GitHub",
      step2: "Register VMs, create agent keys, and download configs from the dashboard UI",
    },

    // --- SHORTCUT: ALREADY HAVE A CONFIG ---
    ifYouAlreadyHaveAConfig: {
      description: "If someone gave you a connector .env file with RELAY_URL, CONNECTOR_TOKEN, and CONNECTOR_ID, you already have everything needed. Skip authentication and registration — go straight to step 4 (install) above. The URL uses the GitHub login of the account that created the connector and the VM name.",
      userUrl: PUBLIC_URL + "/vm/<githubLogin>.<vmName>/",
    },
  });
});

// Terms of Service
app.get("/terms", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Terms of Service - SpAIglass</title>
${FAVICON}
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

<h2>8. Open Source</h2>
<p>SpAIglass is open source software released under the <a href="https://github.com/c0inz/spaiglass/blob/main/LICENSE">MIT License</a>. The complete source code is available at <a href="https://github.com/c0inz/spaiglass">github.com/c0inz/spaiglass</a>.</p>

<h2>9. Changes</h2>
<p>We may update these terms. Continued use after changes constitutes acceptance.</p>

<p><a href="/">&larr; Back to SpAIglass</a></p>
</body></html>`);
});

// Privacy Policy
app.get("/privacy", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Privacy Policy - SpAIglass</title>
${FAVICON}
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

<h2>7. Open Source</h2>
<p>SpAIglass is open source under the <a href="https://github.com/c0inz/spaiglass/blob/main/LICENSE">MIT License</a>. You can audit the complete relay source code at <a href="https://github.com/c0inz/spaiglass/tree/main/relay/src">github.com/c0inz/spaiglass</a> to verify exactly what data is collected and how it flows.</p>

<h2>8. Changes</h2>
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
${FAVICON}
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
${FAVICON}
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

<h2>Agent Keys</h2>
<p style="font-size: 0.9em; color: #666;">Agent keys let scripts and LLM agents register VMs on your behalf without a browser.</p>
<div style="display: flex; gap: 8px; align-items: center;">
  <input id="keyName" placeholder="Key name (e.g. provisioner)" />
  <button class="btn-primary" onclick="addKey()">Create Key</button>
</div>
<div id="agentKeys" style="margin-top: 12px;"></div>

<h2>Setup Guide</h2>
<div class="card">
  <p><strong>1.</strong> Register a VM above — you'll get a connector token.</p>
  <p><strong>2.</strong> On the VM, download the config or set these env vars:</p>
  <pre>RELAY_URL=${PUBLIC_URL}
CONNECTOR_TOKEN=&lt;from registration&gt;</pre>
  <p><strong>3.</strong> Start SpAIglass backend — it connects to the relay automatically.</p>
  <p><strong>4.</strong> Access your VM at <code>${PUBLIC_URL}/vm/${user.github_login}.&lt;vmName&gt;/</code></p>
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
        \${c.online ? \`<button class="btn-primary" onclick="window.open('/vm/${user.github_login}.' + c.name + '/')">Open</button>\` : ''}
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

async function loadKeys() {
  const res = await fetch('/api/agent-keys');
  const data = await res.json();
  const el = document.getElementById('agentKeys');
  if (data.length === 0) {
    el.innerHTML = '<div class="card" style="color: #94a3b8;">No agent keys yet.</div>';
    return;
  }
  el.innerHTML = data.map(k => \`
    <div class="card" style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <strong>\${k.name}</strong>
        <div style="font-size: 0.85em; color: #666; margin-top: 2px;">\${k.prefix} &middot; Created \${new Date(k.created_at).toLocaleDateString()}</div>
      </div>
      <button class="btn-danger" onclick="deleteKey('\${k.id}')">Delete</button>
    </div>
  \`).join('');
}

async function addKey() {
  const name = document.getElementById('keyName').value.trim();
  if (!name) return alert('Enter a key name');
  const res = await fetch('/api/agent-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (data.key) {
    alert('Agent key created!\\n\\nKey (save this — shown only once):\\n' + data.key);
  }
  document.getElementById('keyName').value = '';
  loadKeys();
}

async function deleteKey(id) {
  if (!confirm('Delete this agent key?')) return;
  await fetch('/api/agent-keys/' + id, { method: 'DELETE' });
  loadKeys();
}

loadConnectors();
loadKeys();
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

// Resolve VM slug (githubLogin.vmName) or raw connector ID to a connector
function resolveVmSlug(slug: string): ReturnType<typeof getConnectorById> {
  // Try slug format: githubLogin.vmName
  const dotIndex = slug.indexOf(".");
  if (dotIndex > 0) {
    const login = slug.slice(0, dotIndex);
    const name = slug.slice(dotIndex + 1);
    return getConnectorBySlug(login, name);
  }
  // Fallback: raw connector ID (for backwards compat)
  return getConnectorById(slug);
}

// Browser → VM WebSocket tunnel (must be before wildcard proxy route)
// The frontend connects to /api/ws; the inject script rewrites it to /vm/:slug/api/ws
app.get("/vm/:slug/api/ws", upgradeWebSocket((c) => {
  const slug = c.req.param("slug")!;
  const sessionToken = getCookie(c, SESSION_COOKIE);

  const user = sessionToken ? getUserBySessionToken(sessionToken) : undefined;
  if (!user) {
    return {
      onOpen(_event, ws) {
        ws.send(JSON.stringify({ type: "error", message: "Authentication required" }));
        ws.close();
      },
    };
  }

  const connector = resolveVmSlug(slug);
  if (!connector || connector.user_id !== user.id) {
    return {
      onOpen(_event, ws) {
        ws.send(JSON.stringify({ type: "error", message: "Connector not found" }));
        ws.close();
      },
    };
  }

  const handler = createBrowserWsHandler(connector.id, user.id);
  return {
    onOpen(event, ws) { handler.onOpen(ws); },
    onMessage(event, ws) { handler.onMessage(ws, event); },
    onClose() { handler.onClose(); },
    onError() { handler.onError(); },
  };
}));

// Auth + resolve middleware for all /vm/:slug routes
async function vmAuth(c: Parameters<Parameters<typeof app.get>[1]>[0]): Promise<{ user: NonNullable<ReturnType<typeof getUserBySessionToken>>; connector: NonNullable<ReturnType<typeof resolveVmSlug>> } | Response> {
  const slug = c.req.param("slug")!;
  // Use the user already resolved by authMiddleware (supports both session cookie and agent key)
  const user = c.get("user");

  if (!user) {
    const isAjax = c.req.header("accept")?.includes("application/json") ||
                   c.req.header("x-requested-with") === "XMLHttpRequest";
    if (isAjax) return c.json({ error: "Authentication required" }, 401);
    return c.redirect(`/auth/github?redirect=${encodeURIComponent(c.req.path)}`);
  }

  const connector = resolveVmSlug(slug);
  if (!connector || connector.user_id !== user.id) {
    return c.html(`<!DOCTYPE html>
<html><head><title>VM Not Found</title>
${FAVICON}
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;}</style>
</head><body><h1>VM not found</h1>
<p>No VM matching "${slug}" was found on your account.</p>
<p><a href="/">Back to dashboard</a></p></body></html>`, 404);
  }

  return { user, connector };
}

// URL rewriting script injected into HTML responses from the VM backend.
// Patches fetch() and WebSocket() to prepend /vm/:slug so requests route through the relay.
function makeInjectScript(slug: string): string {
  const prefix = `/vm/${slug}`;
  return `<script>(function(){` +
    `var B='${prefix}';` +
    `var H=location.origin;` +

    // Strip /vm/:slug/... prefix from the URL so React Router sees / and matches.
    // The project/role context is preserved in window.__SG for the frontend to use.
    `var p=location.pathname;` +
    `if(p.indexOf(B)===0){` +
      `var inner=p.slice(B.length).replace(/^\\/+/,'');` +
      `var segs=inner.split('/').filter(Boolean);` +
      `window.__SG={slug:'${slug}',project:segs[0]||'',role:segs[1]||''};` +
      `history.replaceState(null,'','/'+location.search+location.hash);` +
    `}` +

    // Helper: rewrite a URL string if it targets this host and isn't already prefixed
    `function rw(u){` +
      `if(typeof u!=='string')return u;` +
      // Absolute path: /api/... → /vm/slug/api/...
      `if(u[0]==='/'&&u.indexOf(B)!==0)return B+u;` +
      // Full URL on same origin: https://host/api/... → https://host/vm/slug/api/...
      `if(u.indexOf(H)===0){var q=u.slice(H.length);if(q[0]==='/'&&q.indexOf(B)!==0)return H+B+q;}` +
      `return u;` +
    `}` +

    // Patch fetch — handles both string URLs and Request objects
    `var F=window.fetch;window.fetch=function(u,o){` +
      `if(typeof u==='string')u=rw(u);` +
      `else if(u instanceof Request){var nu=rw(u.url);if(nu!==u.url)u=new Request(nu,u);}` +
      `return F.call(this,u,o)};` +

    // Patch WebSocket
    `var W=window.WebSocket;window.WebSocket=function(u,pr){` +
      `if(typeof u==='string'){` +
        // Handle ws:// and wss:// full URLs
        `if(u.indexOf('ws://')===0||u.indexOf('wss://')===0){` +
          `try{var x=new URL(u);if(x.host===location.host&&x.pathname.indexOf(B)!==0){x.pathname=B+x.pathname;u=x.toString();}}catch(e){}}` +
        // Handle /api/ws style paths
        `else{u=rw(u);}` +
      `}` +
      `return new W(u,pr)};` +
    `window.WebSocket.prototype=W.prototype;` +
    `window.WebSocket.CONNECTING=W.CONNECTING;window.WebSocket.OPEN=W.OPEN;window.WebSocket.CLOSING=W.CLOSING;window.WebSocket.CLOSED=W.CLOSED;` +

    // Patch pushState/replaceState so React Router navigations go through the proxy
    `var PS=history.pushState;var RS=history.replaceState;` +
    `history.pushState=function(s,t,u){if(typeof u==='string'&&u[0]==='/'&&u.indexOf(B)!==0)u=B+u;return PS.call(this,s,t,u)};` +
    `history.replaceState=function(s,t,u){if(typeof u==='string'&&u[0]==='/'&&u.indexOf(B)!==0)u=B+u;return RS.call(this,s,t,u)};` +

    `})()</script>`;
}

// Redirect /vm/:slug (no trailing slash) to /vm/:slug/
app.get("/vm/:slug", (c) => {
  return c.redirect(`/vm/${c.req.param("slug")}/`);
});

// HTTP proxy: all /vm/:slug/* requests are forwarded to the VM backend
// via HTTP-over-WebSocket through the connector tunnel
app.all("/vm/:slug/*", async (c) => {
  const slug = c.req.param("slug")!;
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { connector } = auth;

  const cm = getChannelManager();
  if (!cm.isOnline(connector.id)) {
    return c.html(`<!DOCTYPE html>
<html><head><title>VM Offline</title>
${FAVICON}
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;}</style>
</head><body><h1>VM offline</h1>
<p>${connector.name} is not connected to the relay.</p>
<p>Start the connector on the VM to bring it online.</p>
<p><a href="/">Back to dashboard</a></p></body></html>`, 503);
  }

  // Strip /vm/:slug prefix — the VM backend serves from root
  const vmPath = c.req.path.replace(`/vm/${slug}`, "") || "/";
  const queryString = new URL(c.req.url).search;
  const fullVmPath = vmPath + queryString;

  // Forward relevant request headers
  const fwdHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (!["host", "connection", "upgrade", "transfer-encoding", "keep-alive"].includes(lk)) {
      fwdHeaders[key] = value;
    }
  });

  const body = !["GET", "HEAD"].includes(c.req.method) ? await c.req.text() : undefined;

  try {
    const resp = await cm.httpRequest(connector.id, c.req.method, fullVmPath, fwdHeaders, body);

    // Set response headers (skip hop-by-hop)
    for (const [key, value] of Object.entries(resp.headers)) {
      const lk = key.toLowerCase();
      if (!["transfer-encoding", "content-length", "connection"].includes(lk)) {
        c.header(key, value);
      }
    }

    const isHtml = resp.headers["content-type"]?.includes("text/html");

    if (isHtml && resp.bodyEncoding !== "base64") {
      // Inject URL rewriting into HTML responses
      let html = resp.body;
      const prefix = `/vm/${slug}`;

      // Parse project/role from the path for tab title
      const afterSlug = vmPath.replace(/^\//, "").replace(/\/$/, "");
      const pathParts = afterSlug ? afterSlug.split("/") : [];
      const project = pathParts[0] || "";
      const role = pathParts[1] || "";

      // Build compact tab title: "SP:DE — vm-name" or "vm-name — SpAIglass"
      let tabTitle: string;
      if (project && role) {
        tabTitle = `${project.slice(0, 2).toUpperCase()}:${role.slice(0, 2).toUpperCase()} — ${connector.name}`;
      } else if (project) {
        tabTitle = `${project.slice(0, 2).toUpperCase()} — ${connector.name}`;
      } else {
        tabTitle = `${connector.name} — SpAIglass`;
      }

      // Rewrite <title>
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${tabTitle}</title>`);
      // Inject relay favicon
      html = html.replace(/<link rel="icon"[^>]*>/, FAVICON);
      // Rewrite absolute src/href paths in HTML tags
      html = html.replace(/((?:src|href|action)=["'])\/(?!\/)/g, `$1${prefix}/`);
      // Inject the fetch/WebSocket patching script before </head>
      html = html.replace("</head>", makeInjectScript(slug) + "</head>");
      return c.html(html, resp.status as any);
    }

    if (resp.bodyEncoding === "base64") {
      const buf = Buffer.from(resp.body, "base64");
      c.header("Content-Length", buf.length.toString());
      return new Response(buf, { status: resp.status, headers: c.res.headers });
    }

    return c.body(resp.body, resp.status as any);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Proxy error";
    return c.html(`<!DOCTYPE html>
<html><head><title>Proxy Error</title>
${FAVICON}
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;}</style>
</head><body><h1>Proxy error</h1>
<p>${message}</p>
<p><a href="/">Back to dashboard</a></p></body></html>`, 502);
  }
});

// --- Start Server ---

console.log(`SGCleanRelay starting on ${HOST}:${PORT}`);
console.log(`Public URL: ${PUBLIC_URL}`);

const server = createServer();
injectWebSocket(server);
server.on("request", getRequestListener(app.fetch));
server.listen(PORT, HOST, () => {
  console.log(`Listening on ${HOST}:${PORT}`);
});

// Session cleanup every hour
setInterval(() => {
  const cleaned = cleanExpiredSessions();
  if (cleaned > 0) console.log(`Cleaned ${cleaned} expired sessions`);
}, 60 * 60 * 1000);

console.log("SGCleanRelay ready.");
