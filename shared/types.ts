export interface StreamResponse {
  type: "claude_json" | "error" | "done" | "aborted" | "file_delivery";
  data?: unknown; // SDKMessage object for claude_json type, FileDelivery for file_delivery
  error?: string;
}

export interface FileDelivery {
  path: string;
  filename: string;
  action: "write" | "edit";
  /** For Edit actions: the old text being replaced */
  oldString?: string;
  /** For Edit actions: the new text replacing old */
  newString?: string;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: "default" | "plan" | "acceptEdits";
  attachments?: string[]; // server-side file paths from /api/upload
  maxThinkingTokens?: number; // 0 = off, otherwise token budget
}

export interface AbortRequest {
  requestId: string;
}

export interface ProjectInfo {
  path: string;
  encodedName: string;
}

export interface ProjectsResponse {
  projects: ProjectInfo[];
}

// Conversation history types
export interface ConversationSummary {
  sessionId: string;
  startTime: string;
  lastTime: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface HistoryListResponse {
  conversations: ConversationSummary[];
}

// Conversation history types
// Note: messages are typed as unknown[] to avoid frontend/backend dependency issues
// Frontend should cast to TimestampedSDKMessage[] (defined in frontend/src/types.ts)
export interface ConversationHistory {
  sessionId: string;
  messages: unknown[]; // TimestampedSDKMessage[] in practice, but avoiding frontend type dependency
  metadata: {
    startTime: string;
    endTime: string;
    messageCount: number;
  };
}
