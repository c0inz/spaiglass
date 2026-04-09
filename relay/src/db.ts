/**
 * SQLite database for SGCleanRelay.
 * Tables: users, connectors, sessions, agent_keys
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

let db: Database.Database;

export function initDb(path = "./relay.db"): Database.Database {
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id INTEGER UNIQUE NOT NULL,
      github_login TEXT NOT NULL,
      github_name TEXT,
      github_avatar TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      vm_host TEXT,
      vm_port INTEGER DEFAULT 8080,
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      prefix TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized");
  return db;
}

// --- Users ---

export interface User {
  id: string;
  github_id: number;
  github_login: string;
  github_name: string | null;
  github_avatar: string | null;
}

export function upsertUser(githubId: number, login: string, name: string | null, avatar: string | null): User {
  const existing = getDb().prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as User | undefined;
  if (existing) {
    getDb().prepare("UPDATE users SET github_login = ?, github_name = ?, github_avatar = ?, updated_at = datetime('now') WHERE github_id = ?")
      .run(login, name, avatar, githubId);
    return { ...existing, github_login: login, github_name: name, github_avatar: avatar };
  }
  const id = randomUUID();
  getDb().prepare("INSERT INTO users (id, github_id, github_login, github_name, github_avatar) VALUES (?, ?, ?, ?, ?)")
    .run(id, githubId, login, name, avatar);
  return { id, github_id: githubId, github_login: login, github_name: name, github_avatar: avatar };
}

export function getUserById(id: string): User | undefined {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}

// --- Sessions ---

export function createSession(userId: string, ttlHours = 72): { id: string; token: string } {
  const id = randomUUID();
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  getDb().prepare("INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, token, expiresAt);
  return { id, token };
}

export function getUserBySessionToken(token: string): User | undefined {
  const row = getDb().prepare(`
    SELECT u.* FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token) as User | undefined;
  return row;
}

export function deleteSession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function cleanExpiredSessions(): number {
  const result = getDb().prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  return result.changes;
}

// --- Connectors ---

export interface Connector {
  id: string;
  user_id: string;
  name: string;
  token: string;
  vm_host: string | null;
  vm_port: number;
  last_seen: string | null;
  created_at: string;
}

export function createConnector(userId: string, name: string): Connector {
  const id = randomUUID();
  const token = randomUUID();
  getDb().prepare("INSERT INTO connectors (id, user_id, name, token) VALUES (?, ?, ?, ?)")
    .run(id, userId, name, token);
  return { id, user_id: userId, name, token, vm_host: null, vm_port: 8080, last_seen: null, created_at: new Date().toISOString() };
}

export function getConnectorsByUser(userId: string): Connector[] {
  return getDb().prepare("SELECT * FROM connectors WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Connector[];
}

export function getConnectorById(id: string): Connector | undefined {
  return getDb().prepare("SELECT * FROM connectors WHERE id = ?").get(id) as Connector | undefined;
}

export function getConnectorByToken(token: string): Connector | undefined {
  return getDb().prepare("SELECT * FROM connectors WHERE token = ?").get(token) as Connector | undefined;
}

export function deleteConnector(id: string, userId: string): boolean {
  const result = getDb().prepare("DELETE FROM connectors WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function touchConnector(id: string, host?: string, port?: number): void {
  if (host) {
    getDb().prepare("UPDATE connectors SET last_seen = datetime('now'), vm_host = ?, vm_port = ? WHERE id = ?")
      .run(host, port || 8080, id);
  } else {
    getDb().prepare("UPDATE connectors SET last_seen = datetime('now') WHERE id = ?").run(id);
  }
}

// --- Agent Keys ---

export interface AgentKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: string;
}

export function createAgentKey(userId: string, name: string, keyHash: string, prefix: string): AgentKey {
  const id = randomUUID();
  getDb().prepare("INSERT INTO agent_keys (id, user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)")
    .run(id, userId, name, keyHash, prefix);
  return { id, user_id: userId, name, prefix, created_at: new Date().toISOString() };
}

export function getAgentKeysByUser(userId: string): AgentKey[] {
  return getDb().prepare("SELECT id, user_id, name, prefix, created_at FROM agent_keys WHERE user_id = ? ORDER BY created_at DESC").all(userId) as AgentKey[];
}

export function getUserByAgentKeyHash(keyHash: string): User | undefined {
  const row = getDb().prepare(`
    SELECT u.* FROM users u
    JOIN agent_keys ak ON ak.user_id = u.id
    WHERE ak.key_hash = ?
  `).get(keyHash) as User | undefined;
  return row;
}

export function deleteAgentKey(id: string, userId: string): boolean {
  const result = getDb().prepare("DELETE FROM agent_keys WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}
