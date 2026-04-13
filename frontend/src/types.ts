import type {
  SDKMessage as SDKMessageBase,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  PermissionMode as SDKPermissionMode,
} from "@anthropic-ai/claude-agent-sdk";

// All SDK message variants whose discriminator type is "system".
// The SDK splits these into many separate exported types (init, compact_boundary,
// task_notification, ...) and only the init variant is exported as
// SDKSystemMessage. Use Extract to recover the full union for our SystemMessage.
export type SDKSystemLike = Extract<SDKMessageBase, { type: "system" }>;

// Chat message for user/assistant interactions (not part of SDKMessage)
export interface ChatMessage {
  type: "chat";
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// Error message for streaming errors
export type ErrorMessage = {
  type: "error";
  subtype: "stream_error";
  message: string;
  timestamp: number;
};

// Abort message for aborted operations
export type AbortMessage = {
  type: "system";
  subtype: "abort";
  message: string;
  timestamp: number;
};

// Hooks message for hook execution notifications
export type HooksMessage = {
  type: "system";
  content: string;
  level?: string;
  toolUseID?: string;
};

// System message extending SDK types with timestamp.
// SDKSystemLike covers every SDK message with type: "system" (init,
// compact_boundary, task_notification, etc.).
export type SystemMessage = (
  | SDKSystemLike
  | SDKResultMessage
  | ErrorMessage
  | AbortMessage
  | HooksMessage
) & {
  timestamp: number;
};

// Tool message for tool usage display
export type ToolMessage = {
  type: "tool";
  content: string;
  timestamp: number;
};

// Tool result message for tool result display
export type ToolResultMessage = {
  type: "tool_result";
  toolName: string;
  content: string;
  summary: string;
  timestamp: number;
  toolUseResult?: unknown; // Contains structured data like structuredPatch, stdout, stderr etc.
};

// Plan approval dialog state
export interface PlanApprovalDialog {
  isOpen: boolean;
  plan: string;
  toolUseId: string;
}

// Plan message type for UI display
export interface PlanMessage {
  type: "plan";
  plan: string;
  toolUseId: string;
  timestamp: number;
}

// Thinking message for Claude's reasoning process
export interface ThinkingMessage {
  type: "thinking";
  content: string;
  timestamp: number;
}

// Todo item structure for TodoWrite tool results
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

// Todo message for TodoWrite tool result display
export interface TodoMessage {
  type: "todo";
  todos: TodoItem[];
  timestamp: number;
}

// File delivery message — shown when Claude writes or edits a file
export interface FileDeliveryMessage {
  type: "file_delivery";
  path: string;
  filename: string;
  action: "write" | "edit";
  timestamp: number;
  /** For Edit: old text being replaced */
  oldString?: string;
  /** For Edit: new text replacing old */
  newString?: string;
}

/**
 * Phase 6.4 — Interactive widget message.
 *
 * Emitted by the WS hook when a `prompt_secret`, `tool_permission`, or
 * `request_choice` frame arrives over the wire from the host backend's
 * MCP interactive-tools server. The terminal interpreter renders the
 * matching Term* component, and the user's reply is sent back to the
 * backend as a `tool_result` frame keyed by `requestId`.
 *
 * `answered` flips to true after the user submits so the component
 * disables itself and a stale buffer-replay does not let them answer twice.
 */
export interface InteractiveMessage {
  type: "interactive";
  kind: "prompt_secret" | "tool_permission" | "request_choice";
  requestId: string;
  prompt?: string;
  secret?: boolean;
  placeholder?: string | null;
  action?: string;
  details?: string | null;
  choices?: string[];
  answered?: boolean;
  timestamp: number;
}

// Thinking content item from Claude SDK
export interface ThinkingContentItem {
  type: "thinking";
  thinking: string;
}

// TimestampedSDKMessage types for conversation history API
// These extend Claude SDK types with timestamp information
type WithTimestamp<T> = T & { timestamp: string };

export type TimestampedSDKUserMessage = WithTimestamp<SDKUserMessage>;
export type TimestampedSDKAssistantMessage = WithTimestamp<SDKAssistantMessage>;
export type TimestampedSDKSystemMessage = WithTimestamp<SDKSystemLike>;
export type TimestampedSDKResultMessage = WithTimestamp<SDKResultMessage>;

export type TimestampedSDKMessage =
  | TimestampedSDKUserMessage
  | TimestampedSDKAssistantMessage
  | TimestampedSDKSystemMessage
  | TimestampedSDKResultMessage;

export type AllMessage =
  | ChatMessage
  | SystemMessage
  | ToolMessage
  | ToolResultMessage
  | PlanMessage
  | ThinkingMessage
  | TodoMessage
  | FileDeliveryMessage
  | InteractiveMessage;

// Type guard functions
export function isChatMessage(message: AllMessage): message is ChatMessage {
  return message.type === "chat";
}

export function isSystemMessage(message: AllMessage): message is SystemMessage {
  return (
    message.type === "system" ||
    message.type === "result" ||
    message.type === "error"
  );
}

export function isToolMessage(message: AllMessage): message is ToolMessage {
  return message.type === "tool";
}

export function isToolResultMessage(
  message: AllMessage,
): message is ToolResultMessage {
  return message.type === "tool_result";
}

export function isPlanMessage(message: AllMessage): message is PlanMessage {
  return message.type === "plan";
}

export function isThinkingMessage(
  message: AllMessage,
): message is ThinkingMessage {
  return message.type === "thinking";
}

export function isTodoMessage(message: AllMessage): message is TodoMessage {
  return message.type === "todo";
}

export function isFileDeliveryMessage(
  message: AllMessage,
): message is FileDeliveryMessage {
  return message.type === "file_delivery";
}

export function isInteractiveMessage(
  message: AllMessage,
): message is InteractiveMessage {
  return message.type === "interactive";
}

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

// Permission mode types
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

// SDK type integration utilities
export function toSDKPermissionMode(uiMode: PermissionMode): SDKPermissionMode {
  return uiMode as SDKPermissionMode;
}

export function fromSDKPermissionMode(
  sdkMode: SDKPermissionMode,
): PermissionMode {
  return sdkMode as PermissionMode;
}

// Chat state extensions for permission mode
export interface ChatStatePermissions {
  permissionMode: PermissionMode;
  planApprovalDialog: PlanApprovalDialog | null;
  setPermissionMode: (mode: PermissionMode) => void;
  showPlanApprovalDialog: (plan: string, toolUseId: string) => void;
  closePlanApprovalDialog: () => void;
  approvePlan: () => void;
  rejectPlan: () => void;
}

// Permission mode preference type
export interface PermissionModePreference {
  mode: PermissionMode;
  timestamp: number;
}

// Plan approval error types (simplified, realistic)
export interface PlanApprovalError {
  type: "user_rejected" | "network_error";
  message: string;
  canRetry: boolean;
}

export type PlanApprovalResult =
  | { success: true; sessionId: string }
  | { success: false; error: PlanApprovalError };

// Re-export shared types
export type {
  StreamResponse,
  ChatRequest,
  ProjectsResponse,
  ProjectInfo,
  FileDelivery,
} from "../../shared/types";

// Re-export SDK types
export type {
  SDKMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
