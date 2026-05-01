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
  // Richer context for the session picker. Optional so older callers
  // and legacy history files that lack the signal still decode cleanly.
  firstUserMessage?: string;   // first user text message (truncated)
  lastUserMessage?: string;    // most recent user text message (truncated)
  userTurnCount?: number;      // distinct user turns (better "length" than raw line count)
  assistantTurnCount?: number; // distinct assistant turns
  filesTouched?: string[];     // top files from Write/Edit tool_use, sorted by touch count
  model?: string;              // last-seen model id
  cwd?: string;                // cwd recorded in the session
  durationMs?: number;         // lastTime - startTime
}

export interface HistoryListResponse {
  conversations: ConversationSummary[];
}

// Flat picker list — see backend/handlers/claude-sessions.ts.
// Each session is tagged with its origin and (for spaiglass-tracked sessions)
// the working directory + role file so the UI can navigate the user back into
// the right project context on resume.
export interface ClaudeSessionRow extends ConversationSummary {
  source: "spaiglass" | "claude-cli";
  encodedProject: string; // e.g. "-home-foo-projects-bar"
  projectPath: string;    // decoded display value, e.g. "/home/foo/projects/bar"
  spaiglassWorkingDirectory?: string;
  spaiglassRoleFile?: string;
}

export interface ClaudeSessionsResponse {
  sessions: ClaudeSessionRow[];
}

// Conversation history types
// Phase B: history endpoint returns pre-replayed Frame[] (frame-native renderer).
// The backend runs the stored JSONL through a headless FrameEmitter so the
// frontend does not need to host SDK→frame translation.
export interface ConversationHistory {
  sessionId: string;
  /** Ordered Frame[] from server-side replay — consumed by buildFrameState. */
  frames: unknown[]; // Frame[] in practice — typed as unknown[] to avoid shared/frames <-> frontend coupling at shared/types layer
  metadata: {
    startTime: string;
    endTime: string;
    messageCount: number;
  };
}
