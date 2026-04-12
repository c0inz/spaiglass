/**
 * Authentication and rate limiting middleware.
 */

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import { getUserBySessionToken, getUserByAgentKeyHash } from "./db.ts";
import { SESSION_COOKIE } from "./auth.ts";
import type { RelayEnv } from "./types.ts";

/**
 * Auth middleware — sets c.set("user") from cookie or Bearer token.
 * Does NOT reject unauthenticated requests (routes decide that).
 */
export function authMiddleware(): MiddlewareHandler<RelayEnv> {
  return async (c, next) => {
    let user = null;

    // Try session cookie first
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (sessionToken) {
      user = getUserBySessionToken(sessionToken) ?? null;
    }

    // Try Bearer token (agent keys)
    if (!user) {
      const authHeader = c.req.header("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const key = authHeader.slice(7);
        const keyHash = createHash("sha256").update(key).digest("hex");
        user = getUserByAgentKeyHash(keyHash) ?? null;
      }
    }

    c.set("user", user);
    await next();
  };
}

/**
 * Require authenticated user — returns 401 if not authenticated.
 */
export function requireAuth(): MiddlewareHandler<RelayEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }
    await next();
  };
}

/**
 * Simple in-memory rate limiter.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(maxRequests: number, windowMs: number): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("cf-connecting-ip")
      || "unknown";
    const now = Date.now();
    const key = `${ip}:${c.req.path}`;

    let entry = rateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitMap.set(key, entry);
    }

    entry.count++;
    if (entry.count > maxRequests) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    await next();
  };
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

/**
 * Standard security headers applied to every relay response.
 *
 * These headers do not stop a compromised relay from serving its own malicious
 * frontend bundle (see SECURITY.md "Trust assumption: the relay originates the
 * frontend bundle"), but they raise the cost of every other attack class:
 * MITM, third-party CDN compromise, framing/clickjacking, MIME sniffing, and
 * privacy-leaky referrers / browser features.
 *
 * CSP and SRI are wired up separately (Phase 8 steps A and B) because they
 * need to interact with the HTML response body and the Vite build pipeline.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    // Force HTTPS for one year, include subdomains, allow preload-list submission.
    // Safe to send unconditionally — browsers ignore HSTS over plain HTTP.
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );

    // Block framing entirely. Spaiglass has no legitimate iframe embedders.
    c.header("X-Frame-Options", "DENY");

    // Stop browsers from MIME-sniffing responses away from their declared type.
    c.header("X-Content-Type-Options", "nosniff");

    // Send only the origin (not the full path) on cross-origin navigations,
    // and nothing at all on downgrades. Avoids leaking session-id-bearing URLs.
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");

    // Disable browser features Spaiglass does not use. The terminal renderer
    // needs none of these — clipboard read/write is handled inside the WS
    // payload, not via the Async Clipboard API.
    c.header(
      "Permissions-Policy",
      [
        "accelerometer=()",
        "ambient-light-sensor=()",
        "autoplay=()",
        "battery=()",
        "camera=()",
        "display-capture=()",
        "document-domain=()",
        "encrypted-media=()",
        "fullscreen=(self)",
        "geolocation=()",
        "gyroscope=()",
        "magnetometer=()",
        "microphone=()",
        "midi=()",
        "payment=()",
        "picture-in-picture=()",
        "publickey-credentials-get=()",
        "screen-wake-lock=()",
        "sync-xhr=()",
        "usb=()",
        "xr-spatial-tracking=()",
      ].join(", "),
    );

    // Cross-origin isolation primitives. We do not need SharedArrayBuffer or
    // cross-origin window access, so the strictest values are safe.
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
  };
}
