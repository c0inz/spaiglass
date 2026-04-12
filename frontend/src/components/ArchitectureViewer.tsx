/**
 * ArchitectureViewer — rich colored operational manifest renderer.
 *
 * Reads architecture/architecture.json from the project directory and renders
 * every section with distinct accent colors, status badges, box-drawing
 * characters, collapsible panels, and a recursive site-map tree.
 *
 * Sections rendered (all optional — missing sections simply don't appear):
 *   project, server, platform, components, connections, infrastructure,
 *   datastores, frontends, siteMap, users, dataScope, features,
 *   externalSystems, deployments, architectureRules
 */

import { useState, useEffect, type ReactNode } from "react";
import { ChevronRightIcon } from "@heroicons/react/24/outline";

// ═══════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════

interface ArchProject {
  name: string;
  summary: string;
  version?: string;
  repo?: string;
  domain?: string;
  owner?: string;
}

interface ArchServer {
  id: string;
  name: string;
  ip?: string;
  os?: string;
  cpu?: string;
  ram?: string;
  role?: string;
  status?: string;
}

interface ArchPlatform {
  [key: string]: string | undefined;
}

interface ArchComponent {
  id: string;
  name: string;
  type?: string;
  description?: string;
  runsOn?: string[];
  environment?: string[];
  dependsOn?: string[];
  owners?: string[];
  status?: string;
}

interface ArchConnection {
  id?: string;
  from: string;
  to: string;
  mode?: string;
  purpose?: string;
}

interface ArchInfra {
  id: string;
  name: string;
  type?: string;
  description?: string;
  hosts?: string[];
}

interface ArchDatastore {
  id: string;
  name: string;
  engine?: string;
  type?: string;
  path?: string;
  size?: string;
  description?: string;
  status?: string;
}

interface ArchFrontend {
  id: string;
  name: string;
  type?: string;
  framework?: string;
  entryPoint?: string;
  description?: string;
  status?: string;
}

interface ArchSiteMapNode {
  path: string;
  label: string;
  description?: string;
  auth?: boolean;
  children?: ArchSiteMapNode[];
}

interface ArchUser {
  role: string;
  description?: string;
  accessLevel?: string;
  count?: string;
}

interface ArchDataScope {
  entity: string;
  description?: string;
  storage?: string;
  size?: string;
  retention?: string;
  sensitivity?: string;
}

interface ArchFeature {
  id: string;
  name: string;
  description?: string;
  status?: string;
  phase?: string;
  owner?: string;
}

interface ArchExternalSystem {
  id: string;
  name: string;
  type?: string;
  url?: string;
  purpose?: string;
  status?: string;
}

interface ArchDeployment {
  id: string;
  name: string;
  target?: string;
  method?: string;
  script?: string;
  description?: string;
  status?: string;
}

interface ArchEnvironment {
  id: string;
  name: string;
}

interface ArchModel {
  project?: ArchProject;
  server?: ArchServer[];
  platform?: ArchPlatform;
  components?: ArchComponent[];
  connections?: ArchConnection[];
  infrastructure?: ArchInfra[];
  datastores?: ArchDatastore[];
  frontends?: ArchFrontend[];
  siteMap?: ArchSiteMapNode[];
  users?: ArchUser[];
  dataScope?: ArchDataScope[];
  features?: ArchFeature[];
  externalSystems?: ArchExternalSystem[];
  deployments?: ArchDeployment[];
  environments?: ArchEnvironment[];
  architectureRules?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Section theme map — concrete Tailwind classes (no interpolation)
// ═══════════════════════════════════════════════════════════════════

interface SectionTheme {
  headerBg: string;
  hoverBg: string;
  border: string;
  glyph: string;
  title: string;
  count: string;
  chevron: string;
  accent: string;
  dim: string;
}

const T: Record<string, SectionTheme> = {
  server: {
    headerBg: "bg-orange-950/40",
    hoverBg: "hover:bg-orange-950/60",
    border: "border-orange-500/20",
    glyph: "text-orange-400",
    title: "text-orange-300",
    count: "text-orange-500",
    chevron: "text-orange-500",
    accent: "text-orange-300",
    dim: "text-orange-400/50",
  },
  platform: {
    headerBg: "bg-violet-950/40",
    hoverBg: "hover:bg-violet-950/60",
    border: "border-violet-500/20",
    glyph: "text-violet-400",
    title: "text-violet-300",
    count: "text-violet-500",
    chevron: "text-violet-500",
    accent: "text-violet-300",
    dim: "text-violet-400/50",
  },
  components: {
    headerBg: "bg-green-950/40",
    hoverBg: "hover:bg-green-950/60",
    border: "border-green-500/20",
    glyph: "text-green-400",
    title: "text-green-300",
    count: "text-green-500",
    chevron: "text-green-500",
    accent: "text-green-300",
    dim: "text-green-400/50",
  },
  connections: {
    headerBg: "bg-amber-950/40",
    hoverBg: "hover:bg-amber-950/60",
    border: "border-amber-500/20",
    glyph: "text-amber-400",
    title: "text-amber-300",
    count: "text-amber-500",
    chevron: "text-amber-500",
    accent: "text-amber-300",
    dim: "text-amber-400/50",
  },
  infrastructure: {
    headerBg: "bg-blue-950/40",
    hoverBg: "hover:bg-blue-950/60",
    border: "border-blue-500/20",
    glyph: "text-blue-400",
    title: "text-blue-300",
    count: "text-blue-500",
    chevron: "text-blue-500",
    accent: "text-blue-300",
    dim: "text-blue-400/50",
  },
  datastores: {
    headerBg: "bg-rose-950/40",
    hoverBg: "hover:bg-rose-950/60",
    border: "border-rose-500/20",
    glyph: "text-rose-400",
    title: "text-rose-300",
    count: "text-rose-500",
    chevron: "text-rose-500",
    accent: "text-rose-300",
    dim: "text-rose-400/50",
  },
  frontends: {
    headerBg: "bg-teal-950/40",
    hoverBg: "hover:bg-teal-950/60",
    border: "border-teal-500/20",
    glyph: "text-teal-400",
    title: "text-teal-300",
    count: "text-teal-500",
    chevron: "text-teal-500",
    accent: "text-teal-300",
    dim: "text-teal-400/50",
  },
  siteMap: {
    headerBg: "bg-indigo-950/40",
    hoverBg: "hover:bg-indigo-950/60",
    border: "border-indigo-500/20",
    glyph: "text-indigo-400",
    title: "text-indigo-300",
    count: "text-indigo-500",
    chevron: "text-indigo-500",
    accent: "text-indigo-300",
    dim: "text-indigo-400/50",
  },
  users: {
    headerBg: "bg-pink-950/40",
    hoverBg: "hover:bg-pink-950/60",
    border: "border-pink-500/20",
    glyph: "text-pink-400",
    title: "text-pink-300",
    count: "text-pink-500",
    chevron: "text-pink-500",
    accent: "text-pink-300",
    dim: "text-pink-400/50",
  },
  dataScope: {
    headerBg: "bg-yellow-950/40",
    hoverBg: "hover:bg-yellow-950/60",
    border: "border-yellow-500/20",
    glyph: "text-yellow-400",
    title: "text-yellow-300",
    count: "text-yellow-500",
    chevron: "text-yellow-500",
    accent: "text-yellow-300",
    dim: "text-yellow-400/50",
  },
  features: {
    headerBg: "bg-emerald-950/40",
    hoverBg: "hover:bg-emerald-950/60",
    border: "border-emerald-500/20",
    glyph: "text-emerald-400",
    title: "text-emerald-300",
    count: "text-emerald-500",
    chevron: "text-emerald-500",
    accent: "text-emerald-300",
    dim: "text-emerald-400/50",
  },
  external: {
    headerBg: "bg-sky-950/40",
    hoverBg: "hover:bg-sky-950/60",
    border: "border-sky-500/20",
    glyph: "text-sky-400",
    title: "text-sky-300",
    count: "text-sky-500",
    chevron: "text-sky-500",
    accent: "text-sky-300",
    dim: "text-sky-400/50",
  },
  deployments: {
    headerBg: "bg-fuchsia-950/40",
    hoverBg: "hover:bg-fuchsia-950/60",
    border: "border-fuchsia-500/20",
    glyph: "text-fuchsia-400",
    title: "text-fuchsia-300",
    count: "text-fuchsia-500",
    chevron: "text-fuchsia-500",
    accent: "text-fuchsia-300",
    dim: "text-fuchsia-400/50",
  },
  rules: {
    headerBg: "bg-slate-800/40",
    hoverBg: "hover:bg-slate-800/60",
    border: "border-slate-500/20",
    glyph: "text-slate-400",
    title: "text-slate-300",
    count: "text-slate-500",
    chevron: "text-slate-500",
    accent: "text-slate-300",
    dim: "text-slate-400/50",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Shared UI atoms
// ═══════════════════════════════════════════════════════════════════

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const s = status.toLowerCase();
  let cls: string;
  let glyph: string;
  if (s === "active") {
    cls = "bg-green-500/20 text-green-400 border-green-500/30";
    glyph = "●";
  } else if (s === "planned") {
    cls = "bg-amber-500/20 text-amber-400 border-amber-500/30";
    glyph = "◌";
  } else if (s === "deprecated") {
    cls = "bg-red-500/20 text-red-400 border-red-500/30";
    glyph = "✕";
  } else {
    cls = "bg-slate-500/20 text-slate-400 border-slate-500/30";
    glyph = "○";
  }
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${cls}`}
    >
      {glyph} {status}
    </span>
  );
}

function Pill({ children, cls }: { children: ReactNode; cls: string }) {
  return (
    <span
      className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}
    >
      {children}
    </span>
  );
}

function SensitivityBadge({ level }: { level?: string }) {
  if (!level) return null;
  const l = level.toLowerCase();
  if (l === "confidential")
    return (
      <Pill cls="bg-red-500/15 text-red-400 border-red-500/25">
        {level}
      </Pill>
    );
  if (l === "internal")
    return (
      <Pill cls="bg-amber-500/15 text-amber-400 border-amber-500/25">
        {level}
      </Pill>
    );
  return (
    <Pill cls="bg-green-500/15 text-green-400 border-green-500/25">
      {level}
    </Pill>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CollapsibleSection
// ═══════════════════════════════════════════════════════════════════

function CollapsibleSection({
  title,
  theme,
  glyph,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  theme: SectionTheme;
  glyph: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-t-lg border ${theme.headerBg} ${theme.hoverBg} ${theme.border} transition-colors`}
      >
        <span className={`font-mono ${theme.glyph}`}>{glyph}</span>
        <span
          className={`font-semibold text-sm uppercase tracking-wider ${theme.title}`}
        >
          {title}
        </span>
        {count != null && (
          <span className={`text-xs ${theme.count}`}>({count})</span>
        )}
        <ChevronRightIcon
          className={`ml-auto w-4 h-4 ${theme.chevron} transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div
          className={`border border-t-0 ${theme.border} rounded-b-lg bg-slate-900/50 p-3`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Section renderers
// ═══════════════════════════════════════════════════════════════════

function ProjectHeader({ project }: { project?: ArchProject }) {
  if (!project) return null;
  const bar = "═".repeat(56);
  return (
    <div className="font-mono mb-5">
      <div className="flex">
        <span className="text-cyan-500">╔{bar}╗</span>
      </div>
      <div className="flex">
        <span className="text-cyan-500">║</span>
        <span className="text-cyan-100 text-lg font-bold flex-1 px-3 truncate">
          {project.name}
          {project.version && (
            <span className="text-cyan-500/60 text-sm ml-2">
              v{project.version}
            </span>
          )}
        </span>
        <span className="text-cyan-500">║</span>
      </div>
      <div className="flex">
        <span className="text-cyan-500">║</span>
        <span className="text-cyan-300/60 text-sm flex-1 px-3 truncate">
          {project.summary}
        </span>
        <span className="text-cyan-500">║</span>
      </div>
      {(project.repo || project.domain || project.owner) && (
        <div className="flex">
          <span className="text-cyan-500">║</span>
          <span className="text-cyan-400/40 text-xs flex-1 px-3 flex gap-4">
            {project.owner && <span>owner: {project.owner}</span>}
            {project.domain && <span>domain: {project.domain}</span>}
            {project.repo && <span>repo: {project.repo}</span>}
          </span>
          <span className="text-cyan-500">║</span>
        </div>
      )}
      <div className="flex">
        <span className="text-cyan-500">╚{bar}╝</span>
      </div>
    </div>
  );
}

function ServerSection({ servers }: { servers: ArchServer[] }) {
  const t = T.server;
  return (
    <div className="space-y-1.5">
      {servers.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-3 font-mono text-xs py-1"
        >
          <span className={`font-semibold ${t.accent} min-w-[140px] truncate`}>
            {s.name}
          </span>
          {s.ip && <span className={`${t.dim} min-w-[120px]`}>{s.ip}</span>}
          {s.os && (
            <span className="text-slate-400 min-w-[100px] truncate">
              {s.os}
            </span>
          )}
          {s.cpu && <span className="text-slate-500 truncate">{s.cpu}</span>}
          {s.ram && <span className="text-slate-500 truncate">{s.ram}</span>}
          {s.role && (
            <Pill cls="bg-orange-500/10 text-orange-400/70 border-orange-500/20">
              {s.role}
            </Pill>
          )}
          <span className="ml-auto">
            <StatusBadge status={s.status} />
          </span>
        </div>
      ))}
    </div>
  );
}

function PlatformSection({ platform }: { platform: ArchPlatform }) {
  const t = T.platform;
  const entries = Object.entries(platform).filter(
    ([, v]) => v != null && v !== "",
  );
  if (entries.length === 0) return null;
  return (
    <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1 font-mono text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <span className={`font-semibold ${t.accent}`}>{key}</span>
          <span className="text-violet-200">{value}</span>
        </div>
      ))}
    </div>
  );
}

function ComponentsSection({
  components,
  infrastructure,
}: {
  components: ArchComponent[];
  infrastructure?: ArchInfra[];
}) {
  const t = T.components;
  const infraMap = new Map<string, ArchComponent[]>();
  const ungrouped: ArchComponent[] = [];
  for (const c of components) {
    const host = c.runsOn?.[0];
    if (host) {
      if (!infraMap.has(host)) infraMap.set(host, []);
      infraMap.get(host)!.push(c);
    } else {
      ungrouped.push(c);
    }
  }

  const renderCard = (c: ArchComponent) => (
    <div
      key={c.id}
      className={`border ${t.border} rounded-md bg-slate-900/70 p-2 font-mono text-xs`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`font-bold ${t.accent}`}>{c.name}</span>
        {c.type && (
          <Pill cls="bg-green-500/10 text-green-400/70 border-green-500/20">
            {c.type}
          </Pill>
        )}
        <span className="ml-auto">
          <StatusBadge status={c.status} />
        </span>
      </div>
      {c.description && (
        <div className="text-slate-400 text-[11px] leading-snug">
          {c.description}
        </div>
      )}
      {c.dependsOn && c.dependsOn.length > 0 && (
        <div className="text-slate-500 text-[10px] mt-1">
          depends: {c.dependsOn.join(", ")}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {Array.from(infraMap).map(([hostId, comps]) => {
        const infra = infrastructure?.find((i) => i.id === hostId);
        return (
          <div key={hostId}>
            <div
              className={`text-xs font-semibold ${t.dim} uppercase tracking-wider mb-1.5`}
            >
              ┃ {infra?.name || hostId}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 ml-3">
              {comps.map(renderCard)}
            </div>
          </div>
        );
      })}
      {ungrouped.length > 0 && (
        <div>
          <div
            className={`text-xs font-semibold ${t.dim} uppercase tracking-wider mb-1.5`}
          >
            ┃ Standalone
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 ml-3">
            {ungrouped.map(renderCard)}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionsSection({
  connections,
}: {
  connections: ArchConnection[];
}) {
  const t = T.connections;
  return (
    <div className="space-y-1">
      {connections.map((c, i) => {
        const arrow =
          c.mode === "bidirectional" ? "◄━━►" : "━━━►";
        return (
          <div
            key={c.id || i}
            className="flex items-center gap-2 font-mono text-xs py-0.5 flex-wrap"
          >
            <span className={`font-semibold ${t.accent}`}>{c.from}</span>
            <span className={`${t.dim}`}>{arrow}</span>
            <span className={`font-semibold ${t.accent}`}>{c.to}</span>
            {c.mode && c.mode !== "bidirectional" && (
              <Pill cls="bg-amber-500/10 text-amber-400/70 border-amber-500/20">
                {c.mode}
              </Pill>
            )}
            {c.purpose && (
              <span className="text-slate-400 text-[11px]">{c.purpose}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InfraSection({ infra }: { infra: ArchInfra[] }) {
  const t = T.infrastructure;
  return (
    <div className="space-y-2">
      {infra.map((i) => (
        <div
          key={i.id}
          className={`border ${t.border} rounded-md bg-slate-900/70 p-2 font-mono text-xs`}
        >
          <div className="flex items-center gap-2">
            <span className={`font-bold ${t.accent}`}>{i.name}</span>
            {i.type && (
              <Pill cls="bg-blue-500/10 text-blue-400/70 border-blue-500/20">
                {i.type}
              </Pill>
            )}
          </div>
          {i.description && (
            <div className="text-slate-400 text-[11px] mt-0.5">
              {i.description}
            </div>
          )}
          {i.hosts && i.hosts.length > 0 && (
            <div className="text-slate-500 text-[10px] mt-1">
              hosts: {i.hosts.join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DatastoresSection({
  datastores,
}: {
  datastores: ArchDatastore[];
}) {
  const t = T.datastores;
  return (
    <div className="space-y-1.5">
      {datastores.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-3 font-mono text-xs py-0.5 flex-wrap"
        >
          <span className={t.glyph}>◆</span>
          <span className={`font-semibold ${t.accent} min-w-[120px]`}>
            {d.name}
          </span>
          {d.engine && (
            <Pill cls="bg-rose-500/10 text-rose-400/70 border-rose-500/20">
              {d.engine}
            </Pill>
          )}
          {d.type && !d.engine && (
            <Pill cls="bg-rose-500/10 text-rose-400/70 border-rose-500/20">
              {d.type}
            </Pill>
          )}
          {d.path && <span className="text-slate-500 truncate">{d.path}</span>}
          {d.size && <span className="text-slate-500">{d.size}</span>}
          {d.description && (
            <span className="text-slate-400 text-[11px]">{d.description}</span>
          )}
          <span className="ml-auto">
            <StatusBadge status={d.status} />
          </span>
        </div>
      ))}
    </div>
  );
}

function FrontendsSection({ frontends }: { frontends: ArchFrontend[] }) {
  const t = T.frontends;
  return (
    <div className="space-y-1.5">
      {frontends.map((f) => (
        <div
          key={f.id}
          className="flex items-center gap-3 font-mono text-xs py-0.5 flex-wrap"
        >
          <span className={t.glyph}>◈</span>
          <span className={`font-semibold ${t.accent}`}>{f.name}</span>
          {f.type && (
            <Pill cls="bg-teal-500/10 text-teal-400/70 border-teal-500/20">
              {f.type}
            </Pill>
          )}
          {f.framework && (
            <span className="text-slate-400 text-[11px]">{f.framework}</span>
          )}
          {f.description && (
            <span className="text-slate-400 text-[11px]">{f.description}</span>
          )}
          <span className="ml-auto">
            <StatusBadge status={f.status} />
          </span>
        </div>
      ))}
    </div>
  );
}

function SiteMapTree({ nodes }: { nodes: ArchSiteMapNode[] }) {
  const t = T.siteMap;

  function renderNode(
    node: ArchSiteMapNode,
    depth: number,
    isLast: boolean,
    parentPrefix: string,
  ): ReactNode {
    const branch = isLast ? "└── " : "├── ";
    const continuation = isLast ? "    " : "│   ";
    const children = node.children || [];
    return (
      <div key={node.path}>
        <div className="flex items-baseline gap-0 font-mono text-xs">
          <span className={`${t.dim} whitespace-pre`}>
            {parentPrefix}
            {depth > 0 ? branch : ""}
          </span>
          <span className={`font-bold ${t.accent}`}>{node.path}</span>
          <span className="text-slate-400 ml-2 text-[11px]">{node.label}</span>
          {node.auth === false && (
            <Pill cls="bg-indigo-500/10 text-indigo-400/60 border-indigo-500/20 ml-2">
              public
            </Pill>
          )}
          {node.description && (
            <span className="text-slate-500 ml-2 text-[10px]">
              — {node.description}
            </span>
          )}
        </div>
        {children.map((child, ci) =>
          renderNode(
            child,
            depth + 1,
            ci === children.length - 1,
            parentPrefix + (depth > 0 ? continuation : ""),
          ),
        )}
      </div>
    );
  }

  return (
    <div>
      {nodes.map((node, i) =>
        renderNode(node, 0, i === nodes.length - 1, ""),
      )}
    </div>
  );
}

function UsersSection({ users }: { users: ArchUser[] }) {
  const t = T.users;
  return (
    <div className="space-y-1.5">
      {users.map((u) => (
        <div
          key={u.role}
          className="flex items-center gap-3 font-mono text-xs py-0.5 flex-wrap"
        >
          <span className={t.glyph}>●</span>
          <span className={`font-semibold ${t.accent} min-w-[100px]`}>
            {u.role}
          </span>
          {u.description && (
            <span className="text-slate-400 text-[11px]">{u.description}</span>
          )}
          {u.count && <span className="text-slate-500">{u.count}</span>}
          {u.accessLevel && (
            <Pill cls="bg-pink-500/10 text-pink-400/70 border-pink-500/20">
              {u.accessLevel}
            </Pill>
          )}
        </div>
      ))}
    </div>
  );
}

function DataScopeSection({ scope }: { scope: ArchDataScope[] }) {
  const t = T.dataScope;
  return (
    <div className="space-y-1.5">
      {scope.map((d) => (
        <div
          key={d.entity}
          className="flex items-center gap-3 font-mono text-xs py-0.5 flex-wrap"
        >
          <span className={t.glyph}>▣</span>
          <span className={`font-semibold ${t.accent} min-w-[120px]`}>
            {d.entity}
          </span>
          {d.storage && <span className="text-slate-400">{d.storage}</span>}
          {d.size && <span className="text-slate-500">{d.size}</span>}
          {d.retention && (
            <span className="text-slate-500">ret: {d.retention}</span>
          )}
          <SensitivityBadge level={d.sensitivity} />
          {d.description && (
            <span className="text-slate-400 text-[11px]">{d.description}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function FeaturesSection({ features }: { features: ArchFeature[] }) {
  const t = T.features;
  return (
    <div className="space-y-2">
      {features.map((f) => (
        <div key={f.id} className="font-mono text-xs">
          <div className="flex items-center gap-2">
            <span className={t.glyph}>★</span>
            <span className={`font-bold ${t.accent}`}>{f.name}</span>
            {f.phase && (
              <Pill cls="bg-emerald-500/10 text-emerald-400/70 border-emerald-500/20">
                {f.phase}
              </Pill>
            )}
            <span className="ml-auto">
              <StatusBadge status={f.status} />
            </span>
          </div>
          {f.description && (
            <div className="text-slate-400 text-[11px] pl-5 mt-0.5">
              {f.description}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ExternalSection({
  systems,
}: {
  systems: ArchExternalSystem[];
}) {
  const t = T.external;
  return (
    <div className="space-y-1.5">
      {systems.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-3 font-mono text-xs py-0.5 flex-wrap"
        >
          <span className={t.glyph}>⬡</span>
          <span className={`font-semibold ${t.accent}`}>{s.name}</span>
          {s.type && (
            <Pill cls="bg-sky-500/10 text-sky-400/70 border-sky-500/20">
              {s.type}
            </Pill>
          )}
          {s.purpose && (
            <span className="text-slate-400 text-[11px]">{s.purpose}</span>
          )}
          <span className="ml-auto">
            <StatusBadge status={s.status} />
          </span>
        </div>
      ))}
    </div>
  );
}

function DeploymentsSection({
  deployments,
}: {
  deployments: ArchDeployment[];
}) {
  const t = T.deployments;
  return (
    <div className="space-y-2">
      {deployments.map((d) => (
        <div key={d.id} className="font-mono text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={t.glyph}>▶</span>
            <span className={`font-bold ${t.accent}`}>{d.name}</span>
            {d.method && (
              <Pill cls="bg-fuchsia-500/10 text-fuchsia-400/70 border-fuchsia-500/20">
                {d.method}
              </Pill>
            )}
            {d.target && (
              <span className="text-slate-500">→ {d.target}</span>
            )}
            {d.script && (
              <span className="text-slate-500 text-[10px] truncate">
                {d.script}
              </span>
            )}
            <span className="ml-auto">
              <StatusBadge status={d.status} />
            </span>
          </div>
          {d.description && (
            <div className="text-slate-400 text-[11px] pl-5 mt-0.5">
              {d.description}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RulesSection({ rules }: { rules: string[] }) {
  return (
    <div className="space-y-1">
      {rules.map((rule, i) => (
        <div key={i} className="flex gap-2 font-mono text-xs py-0.5">
          <span className="text-slate-500 flex-shrink-0">•</span>
          <span className="text-slate-300">{rule}</span>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════════

interface ArchitectureViewerProps {
  projectPath: string;
}

export function ArchitectureViewer({ projectPath }: ArchitectureViewerProps) {
  const [model, setModel] = useState<ArchModel | null>(null);
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
        setModel(JSON.parse(data.content));
      } catch (err) {
        setError(
          `Failed to parse architecture.json: ${(err as Error).message}`,
        );
      }
      setLoading(false);
    }
    load();
  }, [projectPath]);

  if (loading) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading architecture...</div>
    );
  }

  if (error) {
    const sgBase = (window as Window & { __SG_BASE?: string }).__SG_BASE;
    const setupUrl = sgBase ? `${window.location.origin}/setup` : "/setup";
    return (
      <div className="p-4 text-slate-500 text-sm">
        <p className="mb-2">
          Missing{" "}
          <code className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">
            architecture/architecture.json
          </code>{" "}
          in this project.
        </p>
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

  if (!model) return null;

  return (
    <div className="h-full overflow-auto bg-slate-950 p-4">
      <ProjectHeader project={model.project} />

      {model.server && model.server.length > 0 && (
        <CollapsibleSection
          title="Servers"
          theme={T.server}
          glyph="┃"
          count={model.server.length}
        >
          <ServerSection servers={model.server} />
        </CollapsibleSection>
      )}

      {model.platform && Object.keys(model.platform).length > 0 && (
        <CollapsibleSection
          title="Platform"
          theme={T.platform}
          glyph="▐"
          defaultOpen
        >
          <PlatformSection platform={model.platform} />
        </CollapsibleSection>
      )}

      {model.components && model.components.length > 0 && (
        <CollapsibleSection
          title="Components"
          theme={T.components}
          glyph="┌"
          count={model.components.length}
          defaultOpen
        >
          <ComponentsSection
            components={model.components}
            infrastructure={model.infrastructure}
          />
        </CollapsibleSection>
      )}

      {model.connections && model.connections.length > 0 && (
        <CollapsibleSection
          title="Connections"
          theme={T.connections}
          glyph="►"
          count={model.connections.length}
          defaultOpen
        >
          <ConnectionsSection connections={model.connections} />
        </CollapsibleSection>
      )}

      {model.infrastructure && model.infrastructure.length > 0 && (
        <CollapsibleSection
          title="Infrastructure"
          theme={T.infrastructure}
          glyph="┏"
          count={model.infrastructure.length}
        >
          <InfraSection infra={model.infrastructure} />
        </CollapsibleSection>
      )}

      {model.datastores && model.datastores.length > 0 && (
        <CollapsibleSection
          title="Datastores"
          theme={T.datastores}
          glyph="◆"
          count={model.datastores.length}
        >
          <DatastoresSection datastores={model.datastores} />
        </CollapsibleSection>
      )}

      {model.frontends && model.frontends.length > 0 && (
        <CollapsibleSection
          title="Frontends"
          theme={T.frontends}
          glyph="◈"
          count={model.frontends.length}
        >
          <FrontendsSection frontends={model.frontends} />
        </CollapsibleSection>
      )}

      {model.siteMap && model.siteMap.length > 0 && (
        <CollapsibleSection
          title="Site Map"
          theme={T.siteMap}
          glyph="├"
          defaultOpen
        >
          <SiteMapTree nodes={model.siteMap} />
        </CollapsibleSection>
      )}

      {model.users && model.users.length > 0 && (
        <CollapsibleSection
          title="Users"
          theme={T.users}
          glyph="●"
          count={model.users.length}
        >
          <UsersSection users={model.users} />
        </CollapsibleSection>
      )}

      {model.dataScope && model.dataScope.length > 0 && (
        <CollapsibleSection
          title="Data Scope"
          theme={T.dataScope}
          glyph="▣"
          count={model.dataScope.length}
        >
          <DataScopeSection scope={model.dataScope} />
        </CollapsibleSection>
      )}

      {model.features && model.features.length > 0 && (
        <CollapsibleSection
          title="Features"
          theme={T.features}
          glyph="★"
          count={model.features.length}
          defaultOpen
        >
          <FeaturesSection features={model.features} />
        </CollapsibleSection>
      )}

      {model.externalSystems && model.externalSystems.length > 0 && (
        <CollapsibleSection
          title="External Systems"
          theme={T.external}
          glyph="⬡"
          count={model.externalSystems.length}
        >
          <ExternalSection systems={model.externalSystems} />
        </CollapsibleSection>
      )}

      {model.deployments && model.deployments.length > 0 && (
        <CollapsibleSection
          title="Deployments"
          theme={T.deployments}
          glyph="▶"
          count={model.deployments.length}
        >
          <DeploymentsSection deployments={model.deployments} />
        </CollapsibleSection>
      )}

      {model.architectureRules && model.architectureRules.length > 0 && (
        <CollapsibleSection
          title="Architecture Rules"
          theme={T.rules}
          glyph="•"
          count={model.architectureRules.length}
          defaultOpen
        >
          <RulesSection rules={model.architectureRules} />
        </CollapsibleSection>
      )}
    </div>
  );
}
