import { useEffect, useState } from "react";
import { getProjectsUrl } from "../config/api";
import type { ProjectsResponse } from "../types";
import { ChatPage } from "./ChatPage";

/**
 * Resolves a project-role from window.__SG (set by the relay inject script)
 * and renders ChatPage with the resolved context — without changing the URL.
 *
 * URL pattern: /vm/<slug>/<projectname>-<rolename>/
 * The inject script splits on last hyphen into __SG.project and __SG.role.
 * This component maps project basename → full project path, stores it in
 * window.__SG_RESOLVED, and renders ChatPage which reads from there.
 */
export function RoleResolver() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    resolveProject();
  }, []);

  async function resolveProject() {
    const sg = (
      window as Window & {
        __SG?: {
          project?: string;
          role?: string;
          segment?: string;
        };
      }
    ).__SG;

    if (!sg?.project && !sg?.segment) {
      // No project context — just render ChatPage as-is
      setReady(true);
      return;
    }

    try {
      // Basename matching strategy:
      //   1. Try `sg.segment` (the raw URL segment, e.g. "AgentEPC-origin").
      //      This wins for directories that contain hyphens, which the
      //      inject script would otherwise split into project+role.
      //   2. Fall back to `sg.project` (the hyphen-split value) so legacy
      //      `<project>-<role>/` URLs still resolve.
      //
      // A segment match means the URL was role-less: don't treat `sg.role`
      // as the role file, let the role-probe below pick a default.
      let resolvedPath: string | null = null;
      let segmentMatched = false;

      const candidates = [sg.segment, sg.project].filter(
        (v): v is string => !!v,
      );

      // Try /api/projects first (projects with history in ~/.claude.json)
      const res = await fetch(getProjectsUrl());
      const projectsData: ProjectsResponse | null = res.ok
        ? await res.json()
        : null;

      // Try /api/discover as a second source (projects that haven't been
      // used yet won't appear in /api/projects).
      const discoverRes = await fetch(
        `/api/discover?projectsDir=${encodeURIComponent("~/projects")}`,
      );
      const discoverData = discoverRes.ok ? await discoverRes.json() : null;
      const discoverEntries: Array<{ name: string; path: string }> =
        discoverData
          ? [
              ...(discoverData.projects || []),
              ...(discoverData.unassigned || []),
            ]
          : [];

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const lower = candidate.toLowerCase();

        if (projectsData) {
          const match = projectsData.projects.find((p) => {
            const basename = p.path.split("/").filter(Boolean).pop() || "";
            return basename.toLowerCase() === lower;
          });
          if (match) {
            resolvedPath = match.path;
            segmentMatched = i === 0 && candidate === sg.segment;
            break;
          }
        }

        const discoverMatch = discoverEntries.find(
          (p) => p.name.toLowerCase() === lower,
        );
        if (discoverMatch) {
          resolvedPath = discoverMatch.path;
          segmentMatched = i === 0 && candidate === sg.segment;
          break;
        }
      }

      if (!resolvedPath) {
        // URL references a project/directory that no longer exists on this
        // server (e.g. left over in recents after a registry cleanup).
        // Bounce to the server root so the user lands on the Server+Directory
        // picker. `skip_last_used=1` prevents the relay's `/` handler from
        // redirecting right back to the same stale last-used URL (which
        // would form an infinite loop — the relay only validates that the
        // connector exists and is online, not that the directory is real).
        window.location.replace("/?skip_last_used=1");
        return;
      }

      // Role resolution (optional as of 2026-05-02):
      //   - Legacy <project>-<role>/ URL → honor the explicit role.
      //   - Segment-only URL → probe /api/roles, prefer developer.md if
      //     present, else first available, else leave null.
      //   - No role file in the project → resolvedRole stays null and the
      //     session starts with the SDK's default behavior + any
      //     project-local CLAUDE.md. roleFile is no longer required for
      //     session_start.
      let resolvedRole: string | null =
        !segmentMatched && sg.role ? `${sg.role}.md` : null;
      if (!resolvedRole) {
        try {
          const rolesRes = await fetch(
            `/api/roles?path=${encodeURIComponent(resolvedPath)}`,
          );
          if (rolesRes.ok) {
            const rolesData = (await rolesRes.json()) as {
              roles?: Array<{ filename: string }>;
            };
            const list = rolesData.roles || [];
            const dev = list.find((r) => r.filename === "developer.md");
            resolvedRole = dev?.filename || list[0]?.filename || null;
          }
        } catch {
          // Leave resolvedRole null — chat works fine without a role file.
        }
      }

      // Store resolved context for ChatPage to read
      (
        window as Window & {
          __SG_RESOLVED?: { path: string; role: string | null };
        }
      ).__SG_RESOLVED = {
        path: resolvedPath,
        role: resolvedRole,
      };

      setReady(true);
    } catch {
      setError("Failed to resolve project");
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-600 dark:text-red-400">{error}</div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-slate-600 dark:text-slate-400">Loading...</div>
      </div>
    );
  }

  return <ChatPage />;
}
