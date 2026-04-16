// Live session stats for Help panel
export interface SessionStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number;
  turns: number;
  durationMs: number;
  sessionId: string;
}

// Permission mode types — mirrors SDKPermissionMode from the Agent SDK but kept
// local so the UI layer doesn't pull SDK internals into every consumer.
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

// Re-export shared types that frontend consumers reference via "../types"
export type {
  ProjectsResponse,
  ProjectInfo,
} from "../../shared/types";
