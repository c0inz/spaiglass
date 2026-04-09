import { Context } from "hono";
import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import { logger } from "../utils/logger.ts";

const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * POST /api/upload
 * Accepts multipart/form-data with an image file and workingDirectory field.
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

  // Validate extension
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json(
      { error: `File type ${ext} not allowed. Accepted: ${[...ALLOWED_EXTENSIONS].join(", ")}` },
      400,
    );
  }

  // Validate size
  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400);
  }

  // Create upload directory
  const uploadsDir = join(workingDirectory, ".spyglass", "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });

  // Save with timestamp prefix for uniqueness
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${Date.now()}-${safeName}`;
  const filePath = join(uploadsDir, filename);

  const arrayBuffer = await file.arrayBuffer();
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));

  logger.app.info("Image uploaded: {path}", { path: filePath });

  return c.json({
    path: filePath,
    filename: file.name,
    size: file.size,
  });
}
