import { useState, useEffect } from "react";

interface ArchComponent {
  id: string;
  name: string;
  type?: string;
  description?: string;
  runsOn?: string[];
  dependsOn?: string[];
  status?: string;
}

interface ArchConnection {
  from: string;
  to: string;
  mode?: string;
  purpose?: string;
}

interface ArchInfra {
  id: string;
  name: string;
  type?: string;
  hosts?: string[];
}

interface ArchModel {
  project?: { name: string; summary: string };
  components?: ArchComponent[];
  connections?: ArchConnection[];
  infrastructure?: ArchInfra[];
  architectureRules?: string[];
}

function renderAscii(model: ArchModel): string {
  const lines: string[] = [];

  if (model.project) {
    lines.push(`╔${"═".repeat(60)}╗`);
    lines.push(`║  ${model.project.name.padEnd(57)}║`);
    lines.push(`║  ${(model.project.summary || "").slice(0, 57).padEnd(57)}║`);
    lines.push(`╚${"═".repeat(60)}╝`);
    lines.push("");
  }

  // Group components by infrastructure
  const infraMap = new Map<string, ArchComponent[]>();
  const ungrouped: ArchComponent[] = [];

  for (const comp of model.components || []) {
    const host = comp.runsOn?.[0];
    if (host) {
      if (!infraMap.has(host)) infraMap.set(host, []);
      infraMap.get(host)!.push(comp);
    } else {
      ungrouped.push(comp);
    }
  }

  const renderBox = (name: string, status?: string, width = 24): string => {
    const label = status ? `${name} [${status}]` : name;
    const inner = label.slice(0, width - 4).padEnd(width - 4);
    return `┌${"─".repeat(width - 2)}┐\n│ ${inner} │\n└${"─".repeat(width - 2)}┘`;
  };

  // Render infra groups
  for (const [host, comps] of infraMap) {
    const infra = (model.infrastructure || []).find((i) => i.id === host);
    const hostName = infra?.name || host;
    lines.push(`┏${"━".repeat(58)}┓`);
    lines.push(`┃  ${hostName.padEnd(55)}┃`);
    lines.push(`┃${"─".repeat(58)}┃`);

    // Render components in rows of 2
    for (let i = 0; i < comps.length; i += 2) {
      const box1 = renderBox(comps[i].name, comps[i].status);
      const box2 =
        i + 1 < comps.length
          ? renderBox(comps[i + 1].name, comps[i + 1].status)
          : "";
      const lines1 = box1.split("\n");
      const lines2 = box2 ? box2.split("\n") : ["", "", ""];
      for (let j = 0; j < 3; j++) {
        lines.push(
          `┃  ${(lines1[j] || "").padEnd(26)}  ${(lines2[j] || "").padEnd(26)}  ┃`,
        );
      }
    }
    lines.push(`┗${"━".repeat(58)}┛`);
    lines.push("");
  }

  // Ungrouped components
  if (ungrouped.length > 0) {
    lines.push("  Standalone:");
    for (const comp of ungrouped) {
      lines.push(`    ${renderBox(comp.name, comp.status).split("\n").join("\n    ")}`);
    }
    lines.push("");
  }

  // Connections
  if (model.connections && model.connections.length > 0) {
    lines.push("  Connections:");
    for (const conn of model.connections) {
      const arrow = conn.mode === "bidirectional" ? "◄──►" : "────►";
      const purpose = conn.purpose ? ` (${conn.purpose})` : "";
      lines.push(`    ${conn.from} ${arrow} ${conn.to}${purpose}`);
    }
    lines.push("");
  }

  // Rules
  if (model.architectureRules && model.architectureRules.length > 0) {
    lines.push("  Rules:");
    for (const rule of model.architectureRules) {
      lines.push(`    • ${rule}`);
    }
  }

  return lines.join("\n");
}

interface ArchitectureViewerProps {
  projectPath: string;
}

export function ArchitectureViewer({ projectPath }: ArchitectureViewerProps) {
  const [ascii, setAscii] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const archPath = `${projectPath}/architecture/architecture.json`;
        const res = await fetch(
          `/api/files/read?path=${encodeURIComponent(archPath)}`,
        );
        if (!res.ok) {
          setError("No architecture.json found in this project");
          setLoading(false);
          return;
        }
        const data = await res.json();
        const model: ArchModel = JSON.parse(data.content);
        setAscii(renderAscii(model));
      } catch (err) {
        setError(`Failed to parse architecture.json: ${(err as Error).message}`);
      }
      setLoading(false);
    }
    load();
  }, [projectPath]);

  if (loading) {
    return (
      <div className="p-4 text-slate-400 text-sm">
        Loading architecture...
      </div>
    );
  }

  if (error) {
    // Determine setup URL — use relay setup if running under /vm/ prefix, otherwise local /setup
    const sgBase = (window as any).__SG_BASE as string | undefined;
    const setupUrl = sgBase
      ? `${window.location.origin}/setup`
      : "/setup";

    return (
      <div className="p-4 text-slate-500 text-sm">
        <p className="mb-2">Missing <code className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">architecture/architecture.json</code> in this project.</p>
        <p>
          Follow the instructions in the{" "}
          <a
            href={setupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline"
          >
            setup guide
          </a>{" "}
          to create one.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-slate-900 p-4">
      <pre className="text-green-400 font-mono text-xs leading-relaxed whitespace-pre">
        {ascii}
      </pre>
    </div>
  );
}
