import type { Context } from "hono";
import { getEnv } from "../utils/os.ts";
import { hostname } from "node:os";

export function handleConfigRequest(c: Context) {
  const role = getEnv("VM_ROLE") || "Agent";
  const vmName = hostname();
  return c.json({ role, vmName });
}

export function handleHealthRequest(c: Context) {
  const role = getEnv("VM_ROLE") || "Agent";
  return c.json({ status: "ok", role });
}
