/**
 * GET /api/skills
 *
 * Walks `~/.claude/plugins/marketplaces/<marketplace>/external_plugins/
 * <plugin>/skills/<skillName>/SKILL.md` and returns the parsed frontmatter
 * for every user-invocable skill. Powers the SpaiGlass "skills chip row"
 * above the chat input — the user pins favourites which then render as
 * one-click chips.
 *
 * Skills with `user-invocable: false` (or missing the flag) are auto-only
 * and intentionally hidden from the chip row — the agent decides when to
 * fire those, not the user.
 */

import type { Context } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.ts";

export interface SkillInfo {
  /** "<plugin>:<skill-name>" — stable id, also the slash-command form. */
  id: string;
  /** e.g. "superpowers" */
  pluginId: string;
  /** e.g. "claude-plugins-official" */
  marketplace: string;
  /** Skill's `name` frontmatter field (e.g. "brainstorming"). */
  name: string;
  /** Skill's `description` frontmatter field. */
  description: string;
  /** Slash-command invocation form (e.g. "/superpowers:brainstorming"). */
  slashCommand: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/**
 * Minimal YAML extractor for the fields we care about. Handles:
 *   key: value
 *   key: "quoted value"
 *   user-invocable: true|false
 * Doesn't try to be a full YAML parser — SKILL.md frontmatter is small.
 */
function parseSkillFrontmatter(yaml: string): {
  name?: string;
  description?: string;
  userInvocable?: boolean;
} {
  const out: { name?: string; description?: string; userInvocable?: boolean } =
    {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    const stripped = val.trim().replace(/^["'](.*)["']$/, "$1");
    if (key === "name") out.name = stripped;
    else if (key === "description") out.description = stripped;
    else if (key === "user-invocable" || key === "user_invocable")
      out.userInvocable =
        stripped.toLowerCase() === "true" || stripped === "yes";
  }
  return out;
}

async function readSkill(filePath: string): Promise<{
  name?: string;
  description?: string;
  userInvocable?: boolean;
} | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const m = raw.match(FRONTMATTER_RE);
    if (!m) return null;
    return parseSkillFrontmatter(m[1]);
  } catch {
    return null;
  }
}

export async function handleGetSkills(c: Context) {
  const skills: SkillInfo[] = [];
  const root = join(homedir(), ".claude", "plugins", "marketplaces");

  try {
    const marketplaces = await readdir(root, { withFileTypes: true });
    for (const mp of marketplaces) {
      if (!mp.isDirectory()) continue;
      const externalDir = join(root, mp.name, "external_plugins");
      let plugins;
      try {
        plugins = await readdir(externalDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue;
        const skillsDir = join(externalDir, plugin.name, "skills");
        let skillDirs;
        try {
          skillDirs = await readdir(skillsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sk of skillDirs) {
          if (!sk.isDirectory()) continue;
          const skillFile = join(skillsDir, sk.name, "SKILL.md");
          const fm = await readSkill(skillFile);
          if (!fm || fm.userInvocable !== true) continue;
          if (!fm.name) continue;
          const id = `${plugin.name}:${fm.name}`;
          skills.push({
            id,
            pluginId: plugin.name,
            marketplace: mp.name,
            name: fm.name,
            description: fm.description ?? "",
            slashCommand: `/${id}`,
          });
        }
      }
    }
  } catch (err) {
    logger.app.error("Failed to enumerate skills: {err}", { err: String(err) });
  }

  // Stable order: by plugin then skill name.
  skills.sort((a, b) =>
    a.pluginId === b.pluginId
      ? a.name.localeCompare(b.name)
      : a.pluginId.localeCompare(b.pluginId),
  );
  return c.json({ skills });
}
