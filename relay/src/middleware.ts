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
