import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getProjectsUrl } from "../config/api";
import type { ProjectsResponse } from "../types";

/**
 * Resolves a project-role from window.__SG (set by the relay inject script)
 * and navigates to the correct ChatPage URL.
 *
 * URL pattern: /vm/<slug>/<projectname>-<rolename>/
 * The inject script splits on last hyphen into __SG.project and __SG.role.
 * This component maps project basename → full project path, then navigates.
 */
export function RoleResolver() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sg = (window as any).__SG as
      | { project?: string; role?: string; segment?: string }
      | undefined;

    if (!sg?.project) {
      // No project context — go to project selector
      navigate("/", { replace: true });
      return;
    }

    resolveAndNavigate(sg.project, sg.role || "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolveAndNavigate(projectName: string, roleName: string) {
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
        return basename.toLowerCase() === projectName.toLowerCase();
      });

      if (!match) {
        setError(`Project "${projectName}" not found`);
        return;
      }

      const normalizedPath = match.path.startsWith("/")
        ? match.path
        : `/${match.path}`;

      if (roleName) {
        navigate(`/projects${normalizedPath}?role=${roleName}.md`, {
          replace: true,
        });
      } else {
        navigate(`/projects${normalizedPath}`, { replace: true });
      }
    } catch {
      setError("Failed to resolve project");
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="text-red-600 dark:text-red-400 mb-4">{error}</div>
          <button
            onClick={() => navigate("/", { replace: true })}
            className="text-blue-500 hover:text-blue-400"
          >
            Go to project selector
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-slate-600 dark:text-slate-400">Loading...</div>
    </div>
  );
}
