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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolveProject() {
    const sg = (window as any).__SG as
      | { project?: string; role?: string }
      | undefined;

    if (!sg?.project) {
      // No project context — just render ChatPage as-is
      setReady(true);
      return;
    }

    try {
      const res = await fetch(getProjectsUrl());
      if (!res.ok) {
        setError("Failed to load projects");
        return;
      }

      const data: ProjectsResponse = await res.json();

      // Find project whose path basename matches (case-insensitive)
      const match = data.projects.find((p) => {
        const basename = p.path.split("/").filter(Boolean).pop() || "";
        return basename.toLowerCase() === sg.project!.toLowerCase();
      });

      if (!match) {
        setError(`Project "${sg.project}" not found`);
        return;
      }

      // Store resolved context for ChatPage to read
      (window as any).__SG_RESOLVED = {
        path: match.path,
        role: sg.role ? `${sg.role}.md` : null,
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
