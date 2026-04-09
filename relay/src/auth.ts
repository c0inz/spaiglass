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

    return c.redirect("/");
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
