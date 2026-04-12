import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { getEnv } from "../utils/os.ts";
import { createHash, randomBytes } from "node:crypto";

const SESSION_COOKIE = "spyglass_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Generate a secret for signing cookies (per-process, regenerates on restart)
const COOKIE_SECRET = randomBytes(32).toString("hex");

function hashSession(password: string): string {
  return createHash("sha256")
    .update(password + COOKIE_SECRET)
    .digest("hex");
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Spyglass — Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0f0f1a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-box {
      background: #1e1e2e;
      border: 1px solid #2d2d3f;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 360px;
    }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #64748b; font-size: 14px; margin-bottom: 28px; }
    input {
      width: 100%;
      padding: 10px 14px;
      background: #0f0f1a;
      border: 1px solid #2d2d3f;
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 14px;
      margin-bottom: 16px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #4f6fff; }
    button {
      width: 100%;
      padding: 10px;
      background: #4f6fff;
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #3d5ce0; }
    .error {
      color: #f87171;
      font-size: 13px;
      margin-bottom: 12px;
      display: none;
    }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Spyglass</h1>
    <p class="subtitle">Enter password to continue</p>
    <p class="error" id="error">Incorrect password</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus required />
      <button type="submit">Log In</button>
    </form>
  </div>
  <script>
    if (new URLSearchParams(location.search).has('error')) {
      document.getElementById('error').classList.add('show');
    }
  </script>
</body>
</html>`;

export function createAuthMiddleware() {
  const authPassword = getEnv("AUTH_PASSWORD");

  // If no AUTH_PASSWORD set, skip auth entirely (relay handles OAuth upstream)
  if (!authPassword) {
    console.warn(
      "[AUTH] WARNING: AUTH_PASSWORD is not set. All endpoints are unauthenticated. " +
        "This is only safe when the relay handles authentication upstream.",
    );
    return createMiddleware(async (_c, next) => {
      await next();
    });
  }

  const validSessionHash = hashSession(authPassword);

  return createMiddleware(async (c, next) => {
    const path = c.req.path;

    // Allow login page and login POST without auth
    if (path === "/login") {
      if (c.req.method === "POST") {
        const body = await c.req.parseBody();
        const password = body["password"] as string;

        if (password === authPassword) {
          setCookie(c, SESSION_COOKIE, validSessionHash, {
            path: "/",
            httpOnly: true,
            maxAge: SESSION_MAX_AGE,
            sameSite: "Lax",
          });
          return c.redirect("/", 302);
        }
        return c.redirect("/login?error=1", 302);
      }

      // GET /login — serve login page
      return c.html(LOGIN_HTML);
    }

    // Check session cookie
    const session = getCookie(c, SESSION_COOKIE);
    if (session === validSessionHash) {
      await next();
      return;
    }

    // No valid session — redirect browsers, return 401 for API
    if (path.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.redirect("/login", 302);
  });
}
