/**
 * GitHub OAuth authentication routes.
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createSession, deleteSession, upsertUser } from "./db.ts";
import type { RelayEnv } from "./types.ts";

const SESSION_COOKIE = "sg_session";

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

    // Redirect to saved post-login URL or fleet relay
    const postLoginRedirect = getCookie(c, "oauth_redirect");
    deleteCookie(c, "oauth_redirect");
    // Only allow relative paths to prevent open redirect
    const target = postLoginRedirect?.startsWith("/") ? postLoginRedirect : "/fleetrelay";
    return c.redirect(target);
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
    const body = await c.req.json<{ github_pat: string; key_name?: string }>().catch(() => null);
    if (!body?.github_pat || typeof body.github_pat !== "string") {
      return c.json({ error: "github_pat is required" }, 400);
    }

    // Verify PAT against GitHub API
    const ghRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${body.github_pat}`,
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
    const keyName = body.key_name || `auto-${ghUser.login}-${Date.now()}`;

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
