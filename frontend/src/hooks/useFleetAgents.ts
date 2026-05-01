/**
 * useFleetAgents — Fetches fleet connectors + roles from the relay,
 * tracks recently used agents in localStorage.
 */

import { useState, useEffect, useCallback, useRef } from "react";

export interface FleetConnector {
  id: string;
  name: string;
  displayName: string;
  role: "owner" | "editor" | "viewer";
  online: boolean;
}

export interface FleetRole {
  project: string;
  displayName: string | null;
  projectPath: string;
  roleFile: string;
  roleName: string;
  segment: string;
  url: string;
  connectorName: string;
  connectorDisplayName: string;
}

export interface FleetDirectory {
  name: string;
  displayName: string | null;
  path: string;
  segment: string;
  url: string;
  hasRoles: boolean;
  connectorName: string;
  connectorDisplayName: string;
}

export interface RecentAgent {
  url: string;
  label: string;
  connectorName: string;
  project: string;
  role: string;
  timestamp: number;
}

const RECENT_KEY = "sg_recent_agents";
const MAX_RECENT = 5;

function loadRecent(): RecentAgent[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentAgent[];
  } catch {
    return [];
  }
}

function saveRecent(agents: RecentAgent[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(agents.slice(0, MAX_RECENT)));
}

export function useFleetAgents() {
  const [connectors, setConnectors] = useState<FleetConnector[]>([]);
  const [roles, setRoles] = useState<FleetRole[]>([]);
  const [directories, setDirectories] = useState<FleetDirectory[]>([]);
  const [recentAgents, setRecentAgents] = useState<RecentAgent[]>(loadRecent);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  // Detect if we're running through the relay (has __SG context)
  const sg = (window as Window & { __SG?: { slug?: string } }).__SG;
  const isRelay = !!sg?.slug;

  const fetchFleet = useCallback(async () => {
    if (!isRelay) return;
    setLoading(true);
    try {
      const res = await fetch("/api/__relay/fleet");
      if (!res.ok) return;
      const data = await res.json();
      setConnectors(data.connectors || []);

      // Fetch roles + directories for each online connector in parallel.
      // The endpoint is called /roles for historical reasons but now also
      // returns role-less directory entries (Server+Directory flow).
      const onlineConns = (data.connectors || []).filter(
        (c: FleetConnector) => c.online,
      );
      const perConn = await Promise.all(
        onlineConns.map(async (conn: FleetConnector) => {
          try {
            const rolesRes = await fetch(
              `/api/__relay/fleet/${conn.name}/roles`,
            );
            if (!rolesRes.ok) return { roles: [], directories: [], conn };
            const rolesData = await rolesRes.json();
            return {
              roles: rolesData.roles || [],
              directories: rolesData.directories || [],
              conn,
            };
          } catch {
            return { roles: [], directories: [], conn };
          }
        }),
      );

      const allRoles: FleetRole[] = [];
      const allDirs: FleetDirectory[] = [];
      for (const { roles: rs, directories: ds, conn } of perConn) {
        for (const r of rs) {
          allRoles.push({
            ...r,
            connectorName: conn.name,
            connectorDisplayName: conn.displayName,
          });
        }
        for (const d of ds) {
          allDirs.push({
            ...d,
            connectorName: conn.name,
            connectorDisplayName: conn.displayName,
          });
        }
      }
      allRoles.sort((a, b) =>
        (a.displayName || a.project).localeCompare(b.displayName || b.project),
      );
      allDirs.sort((a, b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name),
      );
      setRoles(allRoles);
      setDirectories(allDirs);

      // Prune stored recents: drop only entries whose CONNECTOR is no longer
      // known (deleted/renamed). We intentionally do NOT require an exact
      // URL match against fleet-reported roles/directories — those URLs are
      // canonical shapes that fleet endpoints generate, but stored recents
      // may have trailing slashes, query strings (?new=1), legacy role
      // segments, or the login prefix the server list omits. A strict match
      // was silently dropping every user-visited URL, which left
      // pickServerTarget with no recents to resume and forced the directory
      // picker on every server switch (feedback 2026-04-23: "picking a
      // server still makes me pick a directory"). Stale directory URLs are
      // handled downstream — RoleResolver bounces to `/?skip_last_used=1`
      // when the directory no longer resolves on the VM.
      const knownConnectors = new Set(
        (data.connectors || []).map((c: FleetConnector) =>
          c.name.toLowerCase(),
        ),
      );
      setRecentAgents((prev) => {
        const filtered = prev.filter((a) => {
          const m = a.url.match(/^\/vm\/([^/]+)\//);
          if (!m) return false;
          const seg = m[1];
          const connPart = seg.includes(".")
            ? seg.slice(seg.indexOf(".") + 1)
            : seg;
          return knownConnectors.has(connPart.toLowerCase());
        });
        if (filtered.length !== prev.length) saveRecent(filtered);
        return filtered;
      });
    } catch {
      // Failed to fetch fleet
    } finally {
      setLoading(false);
    }
  }, [isRelay]);

  // Fetch once on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchFleet();
  }, [fetchFleet]);

  // Record that an agent was used (call on page load for current agent)
  const recordAgent = useCallback(
    (agent: Omit<RecentAgent, "timestamp">) => {
      setRecentAgents((prev) => {
        const filtered = prev.filter((a) => a.url !== agent.url);
        const updated = [
          { ...agent, timestamp: Date.now() },
          ...filtered,
        ].slice(0, MAX_RECENT);
        saveRecent(updated);
        return updated;
      });

      // Persist last-used agent to relay for post-auth redirect
      fetch("/api/__relay/last-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: agent.url }),
      }).catch(() => {});
    },
    [],
  );

  return {
    connectors,
    roles,
    directories,
    recentAgents,
    loading,
    isRelay,
    fetchFleet,
    recordAgent,
  };
}
