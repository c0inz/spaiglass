/**
 * statusClassifier.ts — Classify Claude SDK messages into human-readable
 * status labels for transient display.
 *
 * Instead of showing raw tool output (full file reads, bash stdout, grep
 * results), the UI shows a single-line status indicator that overwrites
 * itself: "Reading source files…", "Executing tests…", "Searching codebase…"
 *
 * Based on the SpAIglass message compacting design doc.
 */

// ---------------------------------------------------------------------------
// Display status — what the user actually sees
// ---------------------------------------------------------------------------

export interface DisplayStatus {
  /** Human-readable label, e.g. "Reading source files…" */
  label: string;
  /** Category for icon/color selection */
  kind:
    | "thinking"
    | "analysis"
    | "search"
    | "read"
    | "write"
    | "patch"
    | "run"
    | "test"
    | "build"
    | "network"
    | "subagent"
    | "final";
  /** Higher priority replaces lower; prevents downgrade flicker */
  priority: number;
  /** Minimum ms to hold this label before allowing a lower-priority replacement */
  stickyMs: number;
  /** Same dedupeKey = don't re-animate the status line */
  dedupeKey: string;
}

// ---------------------------------------------------------------------------
// Tool category inference
// ---------------------------------------------------------------------------

type ToolCategory =
  | "filesystem"
  | "search"
  | "shell"
  | "test"
  | "build"
  | "edit"
  | "network"
  | "mcp"
  | "subagent"
  | "unknown";

function inferToolCategory(
  name?: string,
  args?: Record<string, unknown>,
): ToolCategory {
  const n = (name ?? "").toLowerCase();

  if (/^(read|glob|list_?dir|ls|tree)$/i.test(n) || /read_file|open_file/.test(n)) return "filesystem";
  if (/^(grep|search|find)$/i.test(n) || /search|grep|find_references/.test(n)) return "search";
  if (/^(edit|write|replace)$/i.test(n) || /edit|patch|write_file|replace/.test(n)) return "edit";
  if (/^(bash|shell|command|exec|run)$/i.test(n) || /bash|shell|command/.test(n)) return "shell";
  if (/mcp/i.test(n)) return "mcp";
  if (/agent|subagent|task/i.test(n)) return "subagent";
  if (/http|fetch|request|web/i.test(n)) return "network";

  // Check args for command-based tools (Bash)
  if (args) {
    const cmd = String(args.command ?? "").toLowerCase();
    if (/\b(pytest|vitest|jest|playwright|cypress|cargo test|go test)\b/.test(cmd)) return "test";
    if (/\b(npm (run )?build|make|docker|podman|compile|tsc|webpack|vite build)\b/.test(cmd)) return "build";
    if (/\b(npm install|pnpm install|yarn|bun install|pip install|apt|brew)\b/.test(cmd)) return "build";
    if (/\b(curl|wget|fetch|http)\b/.test(cmd)) return "network";
    if (/\b(npm (run )?test|npx tsx.*test|node.*test)\b/.test(cmd)) return "test";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Classify a tool_use event
// ---------------------------------------------------------------------------

export function classifyToolUse(
  name: string,
  input: Record<string, unknown>,
): DisplayStatus {
  const category = inferToolCategory(name, input);
  const n = name.toLowerCase();

  // Subagent / Agent tool
  if (category === "subagent") {
    return {
      label: "Delegating to subagent…",
      kind: "subagent",
      priority: 90,
      stickyMs: 1200,
      dedupeKey: "subagent",
    };
  }

  // Edit / patch / write
  if (category === "edit") {
    if (/patch|diff/.test(n)) {
      return { label: "Applying edits…", kind: "patch", priority: 95, stickyMs: 1200, dedupeKey: "patch" };
    }
    if (/write/i.test(n)) {
      return { label: "Updating files…", kind: "write", priority: 92, stickyMs: 1000, dedupeKey: "write" };
    }
    return { label: "Applying edits…", kind: "patch", priority: 95, stickyMs: 1200, dedupeKey: "patch" };
  }

  // Search
  if (category === "search") {
    return { label: "Searching codebase…", kind: "search", priority: 84, stickyMs: 800, dedupeKey: "search" };
  }

  // Filesystem read
  if (category === "filesystem") {
    if (/glob|list|ls|tree/.test(n)) {
      return { label: "Scanning repository…", kind: "analysis", priority: 82, stickyMs: 800, dedupeKey: "repo-scan" };
    }
    return { label: "Reading source files…", kind: "read", priority: 83, stickyMs: 800, dedupeKey: "read" };
  }

  // Shell / Bash — further classify by command content
  if (category === "shell" || /^bash$/i.test(n)) {
    const cmd = String(input.command ?? "").toLowerCase();

    // Tests
    if (/\b(test|pytest|vitest|jest|playwright|cypress|cargo test|go test)\b/.test(cmd)) {
      return { label: "Executing tests…", kind: "test", priority: 96, stickyMs: 1500, dedupeKey: "test" };
    }

    // Build / install
    if (/\b(build|compile|make|webpack|vite build|tsc)\b/.test(cmd)) {
      return { label: "Building project…", kind: "build", priority: 94, stickyMs: 1500, dedupeKey: "build" };
    }
    if (/\b(install|npm i|pnpm i|yarn|bun install|pip install|apt|brew)\b/.test(cmd)) {
      return { label: "Installing dependencies…", kind: "build", priority: 94, stickyMs: 1500, dedupeKey: "install" };
    }

    // Network
    if (/\b(curl|wget|fetch|http)\b/.test(cmd)) {
      return { label: "Fetching data…", kind: "network", priority: 86, stickyMs: 1200, dedupeKey: "network" };
    }

    // Git
    if (/\bgit\b/.test(cmd)) {
      return { label: "Running git…", kind: "run", priority: 85, stickyMs: 1000, dedupeKey: "git" };
    }

    // Generic command
    return { label: "Running command…", kind: "run", priority: 85, stickyMs: 1000, dedupeKey: "command" };
  }

  // Test category (from args inference)
  if (category === "test") {
    return { label: "Executing tests…", kind: "test", priority: 96, stickyMs: 1500, dedupeKey: "test" };
  }

  // Build category
  if (category === "build") {
    return { label: "Building project…", kind: "build", priority: 94, stickyMs: 1500, dedupeKey: "build" };
  }

  // Network / MCP
  if (category === "network" || category === "mcp") {
    return { label: "Fetching data…", kind: "network", priority: 86, stickyMs: 1200, dedupeKey: "network" };
  }

  // Fallback
  return { label: "Working…", kind: "thinking", priority: 10, stickyMs: 500, dedupeKey: "fallback" };
}

// ---------------------------------------------------------------------------
// Classify a tool_result event (uses cached tool info)
// ---------------------------------------------------------------------------

export function classifyToolResult(
  toolName: string,
  input: Record<string, unknown>,
  isError?: boolean,
): DisplayStatus {
  // Tool result means the tool finished — show a completion-flavored status
  // that holds briefly before the next action
  const category = inferToolCategory(toolName, input);

  if (isError) {
    return { label: "Investigating issue…", kind: "analysis", priority: 72, stickyMs: 1000, dedupeKey: "debug" };
  }

  // After a test run, show "Reviewing test output…"
  if (category === "test") {
    return { label: "Reviewing test output…", kind: "test", priority: 88, stickyMs: 800, dedupeKey: "test-review" };
  }

  // After a build, show "Checking build output…"
  if (category === "build") {
    return { label: "Checking build output…", kind: "build", priority: 88, stickyMs: 800, dedupeKey: "build-check" };
  }

  // After a search, show "Analyzing results…"
  if (category === "search") {
    return { label: "Analyzing results…", kind: "analysis", priority: 70, stickyMs: 600, dedupeKey: "analyze" };
  }

  // After reading files
  if (category === "filesystem") {
    return { label: "Analyzing code…", kind: "analysis", priority: 70, stickyMs: 600, dedupeKey: "analyze-code" };
  }

  // After shell command with stderr
  if (category === "shell") {
    const cmd = String(input.command ?? "").toLowerCase();
    if (/\b(curl|wget|fetch)\b/.test(cmd)) {
      return { label: "Processing response…", kind: "network", priority: 70, stickyMs: 600, dedupeKey: "process-response" };
    }
    return { label: "Evaluating output…", kind: "run", priority: 70, stickyMs: 600, dedupeKey: "eval-output" };
  }

  // Generic post-tool
  return { label: "Analyzing…", kind: "analysis", priority: 60, stickyMs: 500, dedupeKey: "analyze-generic" };
}

// ---------------------------------------------------------------------------
// Classify thinking content
// ---------------------------------------------------------------------------

export function classifyThinking(hint?: string): DisplayStatus {
  const raw = (hint ?? "").toLowerCase();

  if (/dependency|import|module|require/.test(raw)) {
    return { label: "Evaluating dependencies…", kind: "analysis", priority: 70, stickyMs: 700, dedupeKey: "deps" };
  }
  if (/plan|approach|steps|strategy/.test(raw)) {
    return { label: "Refining plan…", kind: "thinking", priority: 68, stickyMs: 700, dedupeKey: "plan" };
  }
  if (/bug|error|failure|exception|fix/.test(raw)) {
    return { label: "Investigating issue…", kind: "thinking", priority: 72, stickyMs: 700, dedupeKey: "debug-think" };
  }
  if (/test|assert|expect|spec/.test(raw)) {
    return { label: "Reasoning about tests…", kind: "thinking", priority: 68, stickyMs: 700, dedupeKey: "test-think" };
  }

  return { label: "Analyzing problem…", kind: "thinking", priority: 60, stickyMs: 700, dedupeKey: "thinking" };
}
