/**
 * SQLite database for SGCleanRelay.
 * Tables: users, connectors, sessions, agent_keys, vm_collaborators, vm_audit_log
 */

import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";

/** SHA-256 hash a raw connector token for at-rest storage. */
export function hashConnectorToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

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
      display_name TEXT,
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

    -- Phase 2: multi-user collaboration. The connector owner (connectors.user_id)
    -- always has implicit "owner" role and is NOT stored in this table — only
    -- explicit collaborators. role is one of: 'editor' | 'viewer'.
    CREATE TABLE IF NOT EXISTS vm_collaborators (
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
      invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (connector_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_vm_collab_user ON vm_collaborators(user_id);

    -- Phase 2: audit log for collaboration events.
    -- action: 'collaborator_added' | 'collaborator_removed' | 'collaborator_role_changed'
    CREATE TABLE IF NOT EXISTS vm_audit_log (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vm_audit_connector ON vm_audit_log(connector_id, created_at DESC);

    -- Server-side role labels. Replaces the old localStorage-only approach so
    -- labels survive across devices and cache clears. One row per
    -- (connector, project, roleFile) triple. The label column holds the
    -- user-chosen short name (empty string → deleted / use default).
    CREATE TABLE IF NOT EXISTS role_labels (
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      proj_base TEXT NOT NULL,
      role_file TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (connector_id, proj_base, role_file)
    );

    -- User preferences (key-value per user). Used for last_agent_url, etc.
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );
  `);

  // Migrations — add columns that didn't exist in earlier schema versions.
  try {
    db.exec("ALTER TABLE connectors ADD COLUMN display_name TEXT");
  } catch {
    // Column already exists — ignore.
  }

  // Migration: hash any plaintext connector tokens (UUID format → SHA-256 hex).
  // Plaintext tokens are 36 chars with dashes; hashed tokens are 64 hex chars.
  // This is idempotent — already-hashed tokens won't match the UUID pattern.
  const unhashed = db
    .prepare("SELECT id, token FROM connectors WHERE LENGTH(token) = 36 AND token LIKE '%-%'")
    .all() as { id: string; token: string }[];
  if (unhashed.length > 0) {
    const update = db.prepare("UPDATE connectors SET token = ? WHERE id = ?");
    const migrate = db.transaction(() => {
      for (const row of unhashed) {
        update.run(hashConnectorToken(row.token), row.id);
      }
    });
    migrate();
    console.log(`[db] Migrated ${unhashed.length} connector token(s) to SHA-256 hashes`);
  }

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

export function findUserByLogin(login: string): User | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE LOWER(github_login) = LOWER(?)")
    .get(login) as User | undefined;
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
  /** Immutable slug name — used for URL routing and directory lookups. */
  name: string;
  /** User-editable display name — shown on fleet dashboard and browser tabs. */
  display_name: string | null;
  token: string;
  vm_host: string | null;
  vm_port: number;
  last_seen: string | null;
  created_at: string;
}

/** Returns display_name if set, otherwise falls back to name. */
export function connectorDisplayName(c: { name: string; display_name: string | null }): string {
  return c.display_name || c.name;
}

export function createConnector(userId: string, name: string): Connector & { rawToken: string } {
  const id = randomUUID();
  const rawToken = randomUUID();
  const tokenHash = hashConnectorToken(rawToken);
  getDb().prepare("INSERT INTO connectors (id, user_id, name, token) VALUES (?, ?, ?, ?)")
    .run(id, userId, name, tokenHash);
  // token column now stores the hash; rawToken is returned once for display
  return { id, user_id: userId, name, display_name: null, token: tokenHash, rawToken, vm_host: null, vm_port: 8080, last_seen: null, created_at: new Date().toISOString() };
}

/** Update the user-editable display name. Null clears it (falls back to name). */
export function updateConnectorDisplayName(id: string, userId: string, displayName: string | null): boolean {
  const result = getDb()
    .prepare("UPDATE connectors SET display_name = ? WHERE id = ? AND user_id = ?")
    .run(displayName?.trim() || null, id, userId);
  return result.changes > 0;
}

export function getConnectorsByUser(userId: string): Connector[] {
  return getDb().prepare("SELECT * FROM connectors WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Connector[];
}

export function getConnectorById(id: string): Connector | undefined {
  return getDb().prepare("SELECT * FROM connectors WHERE id = ?").get(id) as Connector | undefined;
}

export function getConnectorByToken(rawToken: string): Connector | undefined {
  const hash = hashConnectorToken(rawToken);
  return getDb().prepare("SELECT * FROM connectors WHERE token = ?").get(hash) as Connector | undefined;
}

export function getConnectorByName(name: string): Connector | undefined {
  return getDb().prepare("SELECT * FROM connectors WHERE LOWER(name) = LOWER(?)").get(name) as Connector | undefined;
}

export function getConnectorBySlug(githubLogin: string, vmName: string): Connector | undefined {
  return getDb().prepare(`
    SELECT c.* FROM connectors c
    JOIN users u ON c.user_id = u.id
    WHERE LOWER(u.github_login) = LOWER(?) AND LOWER(c.name) = LOWER(?)
  `).get(githubLogin, vmName) as Connector | undefined;
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

// --- Collaborators (Phase 2) ---

export type ConnectorRole = "owner" | "editor" | "viewer";

export interface Collaborator {
  connector_id: string;
  user_id: string;
  role: "editor" | "viewer";
  invited_by: string;
  created_at: string;
  github_login: string;
  github_name: string | null;
  github_avatar: string | null;
}

/**
 * Resolve the role a given user has on a given connector.
 *
 * Returns:
 * - "owner" if userId === connector.user_id
 * - "editor" / "viewer" if there's a row in vm_collaborators
 * - null otherwise (no access)
 *
 * Single source of truth for permission checks. Replaces the bare
 * `connector.user_id !== user.id` ownership comparison everywhere.
 */
export function getConnectorAccess(
  connectorId: string,
  userId: string,
): ConnectorRole | null {
  const conn = getDb()
    .prepare("SELECT user_id FROM connectors WHERE id = ?")
    .get(connectorId) as { user_id: string } | undefined;
  if (!conn) return null;
  if (conn.user_id === userId) return "owner";
  const collab = getDb()
    .prepare("SELECT role FROM vm_collaborators WHERE connector_id = ? AND user_id = ?")
    .get(connectorId, userId) as { role: "editor" | "viewer" } | undefined;
  return collab?.role ?? null;
}

/**
 * List explicit collaborators (excludes the owner) on a connector,
 * joined with user profile data so the dashboard can render avatars.
 */
export function listCollaborators(connectorId: string): Collaborator[] {
  return getDb()
    .prepare(
      `SELECT vc.*, u.github_login, u.github_name, u.github_avatar
       FROM vm_collaborators vc
       JOIN users u ON u.id = vc.user_id
       WHERE vc.connector_id = ?
       ORDER BY vc.created_at ASC`,
    )
    .all(connectorId) as Collaborator[];
}

/**
 * Add a collaborator to a connector. Throws if userId already has a row
 * (caller should use updateCollaboratorRole instead) or if the user is the owner.
 */
export function addCollaborator(
  connectorId: string,
  userId: string,
  role: "editor" | "viewer",
  invitedBy: string,
): void {
  const access = getConnectorAccess(connectorId, userId);
  if (access === "owner") {
    throw new Error("Cannot add the owner as a collaborator");
  }
  getDb()
    .prepare(
      `INSERT INTO vm_collaborators (connector_id, user_id, role, invited_by)
       VALUES (?, ?, ?, ?)`,
    )
    .run(connectorId, userId, role, invitedBy);
}

export function updateCollaboratorRole(
  connectorId: string,
  userId: string,
  role: "editor" | "viewer",
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE vm_collaborators SET role = ? WHERE connector_id = ? AND user_id = ?`,
    )
    .run(role, connectorId, userId);
  return result.changes > 0;
}

export function removeCollaborator(connectorId: string, userId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM vm_collaborators WHERE connector_id = ? AND user_id = ?`)
    .run(connectorId, userId);
  return result.changes > 0;
}

/**
 * Connectors that a given user has explicit (non-owner) access to.
 * Used by GET /api/connectors to populate the "Shared with me" section.
 */
export interface SharedConnector extends Connector {
  role: "editor" | "viewer";
  owner_login: string;
}

export function getSharedConnectorsForUser(userId: string): SharedConnector[] {
  return getDb()
    .prepare(
      `SELECT c.*, vc.role as role, u.github_login as owner_login
       FROM vm_collaborators vc
       JOIN connectors c ON c.id = vc.connector_id
       JOIN users u ON u.id = c.user_id
       WHERE vc.user_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(userId) as SharedConnector[];
}

// --- Audit log (Phase 2) ---

export interface AuditLogEntry {
  id: string;
  connector_id: string;
  actor_user_id: string;
  target_user_id: string | null;
  action: string;
  details: string | null;
  created_at: string;
  actor_login?: string;
  target_login?: string | null;
}

export function appendAuditLog(
  connectorId: string,
  actorUserId: string,
  action: string,
  targetUserId: string | null,
  details: Record<string, unknown> | null = null,
): void {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO vm_audit_log (id, connector_id, actor_user_id, target_user_id, action, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      connectorId,
      actorUserId,
      targetUserId,
      action,
      details ? JSON.stringify(details) : null,
    );
}

export function listAuditLog(connectorId: string, limit = 100): AuditLogEntry[] {
  return getDb()
    .prepare(
      `SELECT al.*, ua.github_login as actor_login, ut.github_login as target_login
       FROM vm_audit_log al
       LEFT JOIN users ua ON ua.id = al.actor_user_id
       LEFT JOIN users ut ON ut.id = al.target_user_id
       WHERE al.connector_id = ?
       ORDER BY al.created_at DESC
       LIMIT ?`,
    )
    .all(connectorId, limit) as AuditLogEntry[];
}

// --- Role Labels (server-persisted) ---

export interface RoleLabel {
  connector_id: string;
  proj_base: string;
  role_file: string;
  label: string;
}

/** Get all custom role labels for a connector. */
export function getRoleLabels(connectorId: string): RoleLabel[] {
  return getDb()
    .prepare("SELECT * FROM role_labels WHERE connector_id = ? AND label != ''")
    .all(connectorId) as RoleLabel[];
}

/** Set or clear a single role label. Empty/null label deletes the row. */
export function setRoleLabel(
  connectorId: string,
  projBase: string,
  roleFile: string,
  label: string | null,
): void {
  const trimmed = (label || "").trim();
  if (!trimmed) {
    getDb()
      .prepare("DELETE FROM role_labels WHERE connector_id = ? AND proj_base = ? AND role_file = ?")
      .run(connectorId, projBase, roleFile);
  } else {
    getDb()
      .prepare(
        `INSERT INTO role_labels (connector_id, proj_base, role_file, label, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT (connector_id, proj_base, role_file)
         DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
      )
      .run(connectorId, projBase, roleFile, trimmed);
  }
}

// --- User preferences ---

export function getUserPreference(userId: string, key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = ?")
    .get(userId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setUserPreference(
  userId: string,
  key: string,
  value: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO user_preferences (user_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(userId, key, value);
}
