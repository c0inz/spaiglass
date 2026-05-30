/**
 * GET /api/sessions/:sessionId/download?format=md|jsonl
 *
 * Streams a single session's transcript as a downloadable file.
 *
 * Resolution order (mirrors history/conversationLoader.ts so an exported
 * file matches what the user sees in scrollback):
 *   1. Spaiglass-native: ~/.spaiglass/sessions/<tuple>/frames.jsonl (preferred —
 *      authoritative record including user_message, file_delivery, context_file,
 *      interactive_*, etc.).
 *   2. Claude-CLI fallback: ~/.claude/projects/<encoded>/<sessionId>.jsonl,
 *      replayed through FrameEmitter (lossy but covers sessions we don't own).
 *
 * Formats:
 *   - md (default) — readable Markdown transcript with user/assistant turns
 *     and compact one-line tool summaries.
 *   - jsonl        — raw frames.jsonl (or replayed Frame[] for fallback) for
 *     archival / programmatic use.
 */

import type { Context } from "hono";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Frame } from "../../shared/frames.ts";
import { logger } from "../utils/logger.ts";
import { SESSIONS_ROOT, type SessionMeta } from "../session/persistence.ts";
import { loadConversation } from "../history/conversationLoader.ts";

interface SpaiglassNative {
  meta: SessionMeta;
  rawJsonl: string;
  frames: Frame[];
}

async function findSpaiglassNative(
  sessionId: string,
): Promise<SpaiglassNative | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(SESSIONS_ROOT);
  } catch {
    return null;
  }
  for (const entry of entries) {
    let meta: SessionMeta;
    try {
      const raw = await fs.readFile(
        join(SESSIONS_ROOT, entry, "meta.json"),
        "utf8",
      );
      meta = JSON.parse(raw) as SessionMeta;
    } catch {
      continue;
    }
    if (meta.claudeSessionId !== sessionId) continue;
    let rawJsonl: string;
    try {
      rawJsonl = await fs.readFile(
        join(SESSIONS_ROOT, entry, "frames.jsonl"),
        "utf8",
      );
    } catch {
      rawJsonl = "";
    }
    const frames: Frame[] = [];
    for (const line of rawJsonl.split("\n")) {
      if (!line) continue;
      try {
        frames.push(JSON.parse(line) as Frame);
      } catch {
        // skip malformed line
      }
    }
    return { meta, rawJsonl, frames };
  }
  return null;
}

function safeFilenameFragment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function dateStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (b.type === "thinking" && typeof b.text === "string")
      out.push(`*[thinking]* ${b.text}`);
    else if (b.type === "image") out.push("*[image]*");
    else if (b.type === "file" && typeof b.filename === "string")
      out.push(`*[file: ${b.filename}]*`);
    else if (b.type === "tool_use") {
      const name = typeof b.tool === "string" ? b.tool : "tool";
      const input =
        b.input && typeof b.input === "object"
          ? compactToolInput(b.input as Record<string, unknown>)
          : "";
      out.push(`> **${name}** ${input}`.trim());
    }
  }
  return out.join("\n\n");
}

function compactToolInput(input: Record<string, unknown>): string {
  // Pick a representative field if present, otherwise list keys.
  const candidates = [
    "file_path",
    "path",
    "command",
    "pattern",
    "query",
    "url",
  ];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v === "string") {
      return v.length > 120 ? v.slice(0, 117) + "…" : v;
    }
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  return `(${keys.join(", ")})`;
}

function renderMarkdown(
  frames: Frame[],
  meta: { sessionId: string; projectPath: string; startTs?: number },
): string {
  const lines: string[] = [];
  lines.push(`# SpaiGlass session — ${meta.sessionId}`);
  lines.push("");
  lines.push(`- **Project:** \`${meta.projectPath}\``);
  if (meta.startTs)
    lines.push(`- **Started:** ${formatTimestamp(meta.startTs)}`);
  lines.push(`- **Frames:** ${frames.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const f of frames) {
    switch (f.type) {
      case "user_message": {
        const text = extractText((f as { content?: unknown }).content);
        if (!text.trim()) break;
        lines.push(`## You · ${formatTimestamp(f.ts)}`);
        lines.push("");
        lines.push(text);
        lines.push("");
        break;
      }
      case "assistant_message": {
        const text = extractText((f as { content?: unknown }).content);
        if (!text.trim()) break;
        lines.push(`## Claude · ${formatTimestamp(f.ts)}`);
        lines.push("");
        lines.push(text);
        lines.push("");
        break;
      }
      case "file_delivery": {
        const ff = f as {
          path?: string;
          filename?: string;
          action?: string;
        };
        lines.push(
          `> **${ff.action === "write" ? "Wrote" : "Edited"}** \`${ff.path ?? ff.filename ?? ""}\``,
        );
        lines.push("");
        break;
      }
      case "plan": {
        const pf = f as { plan?: string };
        if (pf.plan) {
          lines.push(`### Plan · ${formatTimestamp(f.ts)}`);
          lines.push("");
          lines.push(pf.plan);
          lines.push("");
        }
        break;
      }
      case "todo": {
        const tf = f as {
          todos?: { content?: string; status?: string }[];
        };
        if (tf.todos && tf.todos.length > 0) {
          lines.push(`### Todo · ${formatTimestamp(f.ts)}`);
          lines.push("");
          for (const t of tf.todos) {
            const box =
              t.status === "completed"
                ? "[x]"
                : t.status === "in_progress"
                  ? "[~]"
                  : "[ ]";
            lines.push(`- ${box} ${t.content ?? ""}`);
          }
          lines.push("");
        }
        break;
      }
      case "error": {
        const ef = f as { category?: string; message?: string };
        if (ef.category !== "notice") {
          lines.push(
            `> **error** ${ef.category ?? ""}: ${ef.message ?? ""}`.trim(),
          );
          lines.push("");
        }
        break;
      }
      // Other frame types (session_init, session_meta, tool_call_*,
      // context_file, interactive_*, system_notice, recap) are intentionally
      // omitted from the human-readable transcript — they're plumbing.
      default:
        break;
    }
  }

  return lines.join("\n");
}

export async function handleSessionDownloadRequest(c: Context) {
  const sessionId = c.req.param("sessionId");
  const format = (c.req.query("format") || "md").toLowerCase();
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  if (format !== "md" && format !== "jsonl") {
    return c.json({ error: "format must be md or jsonl" }, 400);
  }

  try {
    const native = await findSpaiglassNative(sessionId);

    if (native) {
      const projectPath = native.meta.workingDirectory;
      const projectFrag = safeFilenameFragment(
        basename(projectPath) || "session",
      );
      const sessionFrag = sessionId.slice(0, 8);
      const stamp = dateStamp(native.meta.createdAt);
      const ext = format === "jsonl" ? "jsonl" : "md";
      const filename = `${projectFrag}-${sessionFrag}-${stamp}.${ext}`;

      if (format === "jsonl") {
        return new Response(native.rawJsonl, {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
          },
        });
      }
      const body = renderMarkdown(native.frames, {
        sessionId,
        projectPath,
        startTs: native.meta.createdAt,
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Fallback: Claude-CLI session. Decoded paths aren't perfectly available
    // here without the encoded project name — but loadConversation() works
    // by sessionId alone for the spaiglass-native tier; for the SDK fallback
    // it needs the encoded project name. Accept it via ?project= query.
    const encodedProject = c.req.query("project");
    if (!encodedProject) {
      return c.json(
        {
          error:
            "Claude-CLI sessions need ?project=<encodedProjectName> to locate the JSONL",
        },
        400,
      );
    }
    const conv = await loadConversation(encodedProject, sessionId);
    if (!conv) return c.json({ error: "session not found" }, 404);
    const frames = conv.frames as Frame[];
    const projectFrag = safeFilenameFragment(encodedProject);
    const sessionFrag = sessionId.slice(0, 8);
    const stamp = new Date().toISOString().slice(0, 10);
    const ext = format === "jsonl" ? "jsonl" : "md";
    const filename = `${projectFrag}-${sessionFrag}-${stamp}.${ext}`;
    if (format === "jsonl") {
      const lines = frames.map((f) => JSON.stringify(f)).join("\n");
      return new Response(lines, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const body = renderMarkdown(frames, {
      sessionId,
      projectPath: encodedProject.replace(/^-/, "/").replace(/-/g, "/"),
      startTs: frames.length > 0 ? frames[0].ts : Date.now(),
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.app.error("Session download failed: {err}", { err: String(err) });
    return c.json(
      {
        error: "download failed",
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}
