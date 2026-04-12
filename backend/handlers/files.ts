import type { Context } from "hono";
import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Validate that a resolved path is within the user's home directory and
 * not inside sensitive credential directories. Prevents path traversal
 * attacks — every file endpoint MUST call this before any I/O.
 */
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".config/gcloud"];

function validatePath(requestedPath: string): string {
  const resolved = resolve(requestedPath);
  const home = homedir();
  const homePrefix = home.endsWith("/") ? home : home + "/";
  if (resolved !== home && !resolved.startsWith(homePrefix)) {
    throw new Error("Access denied: path outside home directory");
  }
  const rel = relative(home, resolved);
  for (const dir of SENSITIVE_DIRS) {
    if (rel === dir || rel.startsWith(dir + "/")) {
      throw new Error("Access denied: sensitive directory");
    }
  }
  return resolved;
}

interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeEntry[];
}

/**
 * GET /api/files/tree?path=<dir>
 * Returns one level of directory listing for lazy-load tree.
 */
export async function handleFileTreeRequest(c: Context) {
  const dirPath = c.req.query("path");
  if (!dirPath) {
    return c.json({ error: "path parameter required" }, 400);
  }

  try {
    const resolved = validatePath(dirPath);
    const entries = await readdir(resolved, { withFileTypes: true });
    const tree: TreeEntry[] = [];

    for (const entry of entries) {
      // Skip hidden files/dirs and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      tree.push({
        name: entry.name,
        path: join(dirPath, entry.name),
        isDir: entry.isDirectory(),
      });
    }

    // Sort: directories first, then alphabetical
    tree.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({ entries: tree });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("Access denied")) return c.json({ error: msg }, 403);
    return c.json({ error: `Failed to read directory: ${msg}` }, 500);
  }
}

/**
 * GET /api/files/read?path=<file>
 * Returns file contents as text.
 */
export async function handleFileReadRequest(c: Context) {
  const filePath = c.req.query("path");
  if (!filePath) {
    return c.json({ error: "path parameter required" }, 400);
  }

  try {
    const resolved = validatePath(filePath);
    const content = await readFile(resolved, "utf-8");
    return c.json({ content, path: filePath });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("Access denied")) return c.json({ error: msg }, 403);
    return c.json({ error: `Failed to read file: ${msg}` }, 500);
  }
}

/**
 * POST /api/files/write
 * Body: { path: string, content: string }
 * Writes content to file. Path must be within a project directory.
 */
export async function handleFileWriteRequest(c: Context) {
  const body = await c.req.json<{ path: string; content: string }>();
  if (!body.path || body.content === undefined) {
    return c.json({ error: "path and content required" }, 400);
  }

  try {
    const resolved = validatePath(body.path);
    // Ensure parent directory exists
    const parentDir = resolved.substring(0, resolved.lastIndexOf("/"));
    await mkdir(parentDir, { recursive: true });
    await writeFile(resolved, body.content, "utf-8");
    return c.json({ success: true, path: body.path });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("Access denied")) return c.json({ error: msg }, 403);
    return c.json({ error: `Failed to write file: ${msg}` }, 500);
  }
}

/**
 * GET /api/files/snapshot?path=<dir>
 * Returns { files: { "relative/path": mtime_ms } } for change polling.
 */
export async function handleFileSnapshotRequest(c: Context) {
  const dirPath = c.req.query("path");
  if (!dirPath) {
    return c.json({ error: "path parameter required" }, 400);
  }

  try {
    const resolved = validatePath(dirPath);
    const files: Record<string, number> = {};
    await walkDir(resolved, resolved, files);
    return c.json({ files });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("Access denied")) return c.json({ error: msg }, 403);
    return c.json({ error: `Failed to snapshot: ${msg}` }, 500);
  }
}

async function walkDir(
  dir: string,
  root: string,
  result: Record<string, number>,
  depth = 0,
) {
  // Limit depth to prevent scanning huge trees
  if (depth > 5) return;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath, root, result, depth + 1);
      } else {
        const rel = relative(root, fullPath);
        const s = await stat(fullPath);
        result[rel] = s.mtimeMs;
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

/**
 * GET /api/files/list?path=<dir>&recursive=true
 * Returns flat list of all files for @-mention dropdown.
 */
export async function handleFileListRequest(c: Context) {
  const dirPath = c.req.query("path");
  if (!dirPath) {
    return c.json({ error: "path parameter required" }, 400);
  }

  const recursive = c.req.query("recursive") === "true";

  try {
    const resolved = validatePath(dirPath);
    const files: string[] = [];

    if (recursive) {
      await collectFiles(resolved, resolved, files);
    } else {
      const entries = await readdir(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.startsWith(".") && !entry.isDirectory()) {
          files.push(entry.name);
        }
      }
    }

    return c.json({ files });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("Access denied")) return c.json({ error: msg }, 403);
    return c.json({ error: `Failed to list files: ${msg}` }, 500);
  }
}

async function collectFiles(
  dir: string,
  root: string,
  result: string[],
  depth = 0,
) {
  if (depth > 5) return;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectFiles(fullPath, root, result, depth + 1);
      } else {
        result.push(relative(root, fullPath));
      }
    }
  } catch {
    // Skip unreadable directories
  }
}
