/**
 * GitHub OAuth authentication routes.
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  createSession,
  deleteSession,
  upsertUser,
  getUserPreference,
  getConnectorsByUser,
  getConnectorAccess,
} from "./db.ts";
import type { RelayEnv } from "./types.ts";

const SESSION_COOKIE = "sg_session";

/**
 * Confirm a /vm/<slug>/... URL targets a connector the caller still owns.
 * `slug` here is either a bare connector name or `<login>.<connector>`; we
 * accept both shapes because historical URLs mixed them. Case-insensitive
 * match — connector names are case-insensitive at the DB layer.
 *
 * Used to reject stale last_agent_url / postLoginRedirect values after a
 * connector rename or delete, which would otherwise 404 the user on every
 * sign-in.
 */
function vmSlugStillValid(
  url: string,
  connectors: Array<{ name: string }>,
): boolean {
  if (!url.startsWith("/vm/")) {
    // Non-VM redirect (e.g. /setup, /fleetrelay) — assume valid.
    return true;
  }
  const rest = url.slice(4); // strip "/vm/"
  const firstSeg = rest.split("/")[0] || "";
  if (!firstSeg) return false;
  const connectorName = firstSeg.includes(".")
    ? firstSeg.slice(firstSeg.indexOf(".") + 1)
    : firstSeg;
  return connectors.some(
    (c) => c.name.toLowerCase() === connectorName.toLowerCase(),
  );
}

export function authRoutes(): Hono<RelayEnv> {
  const app = new Hono<RelayEnv>();

  // Step 1: Redirect to GitHub
  app.get("/auth/github", (c) => {
    const clientId = c.env.GITHUB_CLIENT_ID;
    const redirectUri = `${c.env.PUBLIC_URL}/auth/github/callback`;
    const state = crypto.randomUUID();

    // Save post-login redirect if provided (e.g. /vm/c0inz.my-vm/)
    const postLoginRedirect = c.req.query("redirect");
    if (postLoginRedirect) {
      setCookie(c, "oauth_redirect", postLoginRedirect, {
        httpOnly: true,
        secure: c.env.PUBLIC_URL.startsWith("https"),
        sameSite: "Lax",
        maxAge: 600,
        path: "/",
      });
    }

    setCookie(c, "oauth_state", state, {
      httpOnly: true,
      secure: c.env.PUBLIC_URL.startsWith("https"),
      sameSite: "Lax",
      maxAge: 600,
      path: "/",
    });

    const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`;
    return c.redirect(url);
  });

  // Step 2: GitHub callback
  app.get("/auth/github/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const savedState = getCookie(c, "oauth_state");

    deleteCookie(c, "oauth_state");

    if (!code || !state || state !== savedState) {
      return c.text("Invalid OAuth state", 400);
    }

    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${c.env.PUBLIC_URL}/auth/github/callback`,
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      return c.text(`OAuth error: ${tokenData.error || "no access token"}`, 400);
    }

    // Fetch user info
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    const ghUser = await userRes.json() as {
      id: number;
      login: string;
      name: string | null;
      avatar_url: string | null;
    };

    // Upsert user and create session
    const user = upsertUser(ghUser.id, ghUser.login, ghUser.name, ghUser.avatar_url);
    const session = createSession(user.id);

    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: c.env.PUBLIC_URL.startsWith("https"),
      sameSite: "Lax",
      maxAge: 72 * 60 * 60, // 72 hours
      path: "/",
    });

    // Redirect to saved post-login URL, or last-used agent, or first available agent.
    // Fetch connectors up-front so we can validate stored redirects against the
    // current fleet — otherwise a renamed or deleted connector leaves the user
    // landing on a 404 every login.
    const connectors = getConnectorsByUser(user.id);
    const postLoginRedirect = getCookie(c, "oauth_redirect");
    deleteCookie(c, "oauth_redirect");
    if (postLoginRedirect?.startsWith("/") && vmSlugStillValid(postLoginRedirect, connectors)) {
      return c.redirect(postLoginRedirect);
    }

    // Try last-used agent URL — only honor it if the connector slug still exists.
    // Preferences stored before a rename would otherwise redirect to /vm/<old>/,
    // which the relay can't route.
    const lastAgent = getUserPreference(user.id, "last_agent_url");
    if (lastAgent?.startsWith("/") && vmSlugStillValid(lastAgent, connectors)) {
      return c.redirect(lastAgent);
    }

    // Fallback: redirect to first owned connector's root (Server+Directory
    // picker on that VM renders next).
    if (connectors.length > 0) {
      return c.redirect(`/vm/${connectors[0].name}/`);
    }

    // No connectors at all — land on fleet relay setup page
    return c.redirect("/fleetrelay");
  });

  // Logout
  app.post("/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      deleteSession(token);
      deleteCookie(c, SESSION_COOKIE);
    }
    return c.json({ ok: true });
  });

  // Token exchange: GitHub PAT → agent key (fully headless, no browser needed)
  app.post("/api/auth/token-exchange", async (c) => {
    const ct = (c.req.header("content-type") || "").toLowerCase();
    if (ct && !ct.includes("application/json")) {
      return c.json({ error: "Content-Type must be application/json" }, 400);
    }
    const body = await c.req
      .json<{ github_pat?: unknown; key_name?: unknown }>()
      .catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.github_pat !== "string" || !body.github_pat.trim()) {
      return c.json({ error: "github_pat is required (string)" }, 400);
    }
    // Shape-reject before we spend a GitHub API round-trip. Classic PATs are
    // `ghp_` + 36 chars; fine-grained are `github_pat_` + ~82 chars; legacy
    // 40-hex PATs still exist. Length bound 20..255 + printable ASCII is
    // conservative enough to pass all three while rejecting obvious garbage.
    const pat = body.github_pat.trim();
    if (pat.length < 20 || pat.length > 255 || !/^[A-Za-z0-9_]+$/.test(pat)) {
      return c.json({ error: "github_pat has invalid shape" }, 400);
    }
    if (body.key_name !== undefined) {
      if (typeof body.key_name !== "string") {
        return c.json({ error: "key_name must be a string" }, 400);
      }
      if (body.key_name.length > 100) {
        return c.json({ error: "key_name max 100 chars" }, 400);
      }
    }

    // Verify PAT against GitHub API
    const ghRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "SpAIglass-Relay",
      },
    });

    if (!ghRes.ok) {
      return c.json({ error: "Invalid GitHub token" }, 401);
    }

    const ghUser = await ghRes.json() as {
      id: number;
      login: string;
      name: string | null;
      avatar_url: string | null;
    };

    // Upsert user from GitHub identity
    const user = upsertUser(ghUser.id, ghUser.login, ghUser.name, ghUser.avatar_url);

    // Generate an agent key for this user
    const { createHash, randomBytes } = await import("node:crypto");
    const rawKey = randomBytes(32).toString("hex");
    const key = `sg_${rawKey}`;
    const keyHash = createHash("sha256").update(key).digest("hex");
    const prefix = `sg_${rawKey.slice(0, 8)}...`;
    const keyName =
      typeof body.key_name === "string" && body.key_name.trim()
        ? body.key_name.trim()
        : `auto-${ghUser.login}-${Date.now()}`;

    const { createAgentKey } = await import("./db.ts");
    const agentKey = createAgentKey(user.id, keyName, keyHash, prefix);

    return c.json({
      user: { login: ghUser.login, name: ghUser.name },
      agent_key: key,
      key_id: agentKey.id,
      key_prefix: agentKey.prefix,
      note: "Save this agent key — it is shown only once. Use it as: Authorization: Bearer <key>",
    }, 201);
  });

  // Current user info
  app.get("/api/auth/me", (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ authenticated: false }, 401);
    }
    return c.json({
      authenticated: true,
      user: {
        id: user.id,
        login: user.github_login,
        name: user.github_name,
        avatar: user.github_avatar,
      },
    });
  });

  return app;
}

export { SESSION_COOKIE };
