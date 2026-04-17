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

      // Fetch roles for each online connector
      const allRoles: FleetRole[] = [];
      for (const conn of data.connectors || []) {
        if (!conn.online) continue;
        try {
          const rolesRes = await fetch(
            `/api/__relay/fleet/${conn.name}/roles`,
          );
          if (!rolesRes.ok) continue;
          const rolesData = await rolesRes.json();
          for (const r of rolesData.roles || []) {
            allRoles.push({
              ...r,
              connectorName: conn.name,
              connectorDisplayName: conn.displayName,
            });
          }
        } catch {
          // Skip connector
        }
      }
      allRoles.sort((a, b) =>
        (a.displayName || a.project).localeCompare(b.displayName || b.project),
      );
      setRoles(allRoles);
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
    recentAgents,
    loading,
    isRelay,
    fetchFleet,
    recordAgent,
  };
}
