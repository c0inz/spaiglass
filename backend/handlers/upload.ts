import { Context } from "hono";
import { promises as fs } from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.ts";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * POST /api/upload
 * Accepts multipart/form-data with any file and workingDirectory field.
 * Saves to {workingDirectory}/.spyglass/uploads/{timestamp}-{filename}
 * Returns { path, filename, size }
 */
export async function handleUploadRequest(c: Context) {
  const body = await c.req.parseBody();

  const file = body["file"];
  const workingDirectory = body["workingDirectory"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  if (!workingDirectory || typeof workingDirectory !== "string") {
    return c.json({ error: "No workingDirectory provided" }, 400);
  }

  // Validate size
  if (file.size > MAX_FILE_SIZE) {
    return c.json(
      {
        error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      },
      400,
    );
  }

  // Validate workingDirectory is within home — prevents arbitrary file write
  const resolvedWd = resolve(workingDirectory as string);
  const home = homedir();
  const homePrefix = home.endsWith("/") ? home : home + "/";
  if (resolvedWd !== home && !resolvedWd.startsWith(homePrefix)) {
    return c.json({ error: "Access denied: path outside home directory" }, 403);
  }
  const rel = relative(home, resolvedWd);
  for (const dir of [".ssh", ".gnupg", ".aws", ".config/gcloud"]) {
    if (rel === dir || rel.startsWith(dir + "/")) {
      return c.json({ error: "Access denied: sensitive directory" }, 403);
    }
  }

  // Create upload directory
  const uploadsDir = join(resolvedWd, ".spyglass", "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });

  // Save with timestamp prefix for uniqueness
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${Date.now()}-${safeName}`;
  const filePath = join(uploadsDir, filename);

  const arrayBuffer = await file.arrayBuffer();
  await fs.writeFile(filePath, new Uint8Array(arrayBuffer));

  logger.app.info("File uploaded: {path}", { path: filePath });

  return c.json({
    path: filePath,
    filename: file.name,
    size: file.size,
  });
}
