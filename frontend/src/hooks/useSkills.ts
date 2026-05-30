/**
 * useSkills — fetches the VM's plugin-skill catalog once on mount.
 *
 * Calls GET /api/skills which walks ~/.claude/plugins/marketplaces/.../
 * skills/*\/SKILL.md and returns user-invocable skills. The list is
 * stable per VM (changes only when the user installs/updates plugins),
 * so we don't poll — fetch once, render forever.
 */

import { useEffect, useState } from "react";

export interface SkillInfo {
  id: string; // "<plugin>:<skill>" — also the slash-command form
  pluginId: string;
  marketplace: string;
  name: string;
  description: string;
  slashCommand: string; // e.g. "/superpowers:brainstorming"
}

export interface UseSkillsResult {
  skills: SkillInfo[];
  loading: boolean;
  error: string | null;
}

export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => {
        if (cancelled) return;
        setSkills(Array.isArray(data?.skills) ? data.skills : []);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { skills, loading, error };
}
