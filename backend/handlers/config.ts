import type { Context } from "hono";
import { getEnv } from "../utils/os.ts";
import { hostname, networkInterfaces } from "node:os";

/**
 * Best-guess primary IPv4 address. Walks os.networkInterfaces() and returns
 * the first non-internal, non-link-local IPv4. We prefer well-known private
 * ranges (192.168/16, 10/8, 172.16/12) over anything else so a VM with a
 * tailscale + LAN + docker bridge reports its LAN address rather than a
 * 100.x tailnet IP or a 172.17 docker bridge.
 */
function pickPrimaryIpv4(): string | null {
  const nets = networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const n of list) {
      if (n.family !== "IPv4" || n.internal) continue;
      candidates.push(n.address);
    }
  }
  if (candidates.length === 0) return null;
  const isLan = (ip: string) =>
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isLan) || candidates[0];
}

export function handleConfigRequest(c: Context) {
  const role = getEnv("VM_ROLE") || "Agent";
  const vmName = hostname();
  const ipv4 = pickPrimaryIpv4();
  return c.json({ role, vmName, ipv4 });
}

export function handleHealthRequest(c: Context) {
  const role = getEnv("VM_ROLE") || "Agent";
  return c.json({ status: "ok", role });
}
