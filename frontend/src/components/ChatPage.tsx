import { useEffect, useCallback, useState, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  FolderIcon,
  CubeTransparentIcon,
  PlusCircleIcon,
} from "@heroicons/react/24/outline";
import type { ProjectInfo, SessionStats } from "../types";
import type { ErrorFrame, UserContentBlock } from "../../../shared/frames";
import { useChatState } from "../hooks/chat/useChatState";
import { useFrameChatState } from "../hooks/chat/useFrameChatState";
import { usePermissions } from "../hooks/chat/usePermissions";
import { usePermissionMode } from "../hooks/chat/usePermissionMode";
import { useAutoHistoryLoader } from "../hooks/useHistoryLoader";
import { useWebSocketSession } from "../hooks/useWebSocketSession";
import { SettingsButton } from "./SettingsButton";
import { SettingsModal } from "./SettingsModal";
import { ChatInput } from "./chat/ChatInput";
import { FrameChatView } from "../terminal/frames/FrameChatView";
import { FileSidebar } from "./FileSidebar";
import { FileEditor } from "./FileEditor";
import { FileMention } from "./FileMention";
import { NewSessionDialog } from "./NewSessionDialog";
import { StaleContextBanner } from "./StaleContextBanner";
import { ArchitectureViewer } from "./ArchitectureViewer";
import { MobileTabBar, type MobileTab } from "./MobileTabBar";
import { AgentSwitcher, AgentPickerFullPage } from "./AgentSwitcher";
import { useFleetAgents } from "../hooks/useFleetAgents";
import { useIsMobile } from "../hooks/useIsMobile";
import { useFilePolling } from "../hooks/useFilePolling";
import { getProjectsUrl } from "../config/api";
import { KEYBOARD_SHORTCUTS } from "../utils/constants";
import { normalizeWindowsPath } from "../utils/pathUtils";
import { useVmConfig } from "../hooks/useVmConfig";
// Project display names are fetched from the VM backend (server-side
// storage so all browsers see the same labels). The localStorage
// utility is kept only as a migration fallback during the transition.
import { getProjectDisplayName as getLocalDisplayName } from "../utils/projectDisplayName";

export function ChatPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [sessionFocusBump, setSessionFocusBump] = useState(0);
  const [showSidebar, setShowSidebar] = useState(false);
  const [editingFile, setEditingFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [contextFiles, setContextFiles] = useState<Set<string>>(new Set());
  const [contextFilesList, setContextFilesList] = useState<
    { path: string; name: string; touchedAt: number }[]
  >([]);
  const [activeContext, setActiveContext] = useState<{
    name: string;
    filename: string;
    path: string;
    content?: string;
  } | null>(null);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextChecked, setContextChecked] = useState(false);
  const [mentionState, setMentionState] = useState<{
    query: string;
    position: { top: number; left: number };
  } | null>(null);
  const [staleFiles, setStaleFiles] = useState<string[]>([]);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [showArchViewer, setShowArchViewer] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [pendingImages, setPendingImages] = useState<
    { file: File; preview: string }[]
  >([]);
  const [thinkingLevel, setThinkingLevel] = useState<
    "off" | "brief" | "extended"
  >("off");
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const sessionStatsRef = useRef<SessionStats>({
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCost: 0,
    turns: 0,
    durationMs: 0,
    sessionId: "",
  });
  const [sessionStats, setSessionStats] = useState<SessionStats>(
    sessionStatsRef.current,
  );
  // VM hostname + primary LAN IP — shown next to the working directory in
  // the header so the user can tell at a glance which machine they're on
  // when jumping across the fleet.
  const vmConfig = useVmConfig();

  // Fleet agent switcher — fetches connectors + roles from relay
  const fleet = useFleetAgents();

  // Project display names — fetched from VM backend so all browsers agree.
  // Falls back to localStorage (legacy) then directory basename.
  const [projectDisplayNames, setProjectDisplayNames] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    fetch("/api/settings/project-display-names")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.displayNames) setProjectDisplayNames(data.displayNames);
      })
      .catch(() => {});
  }, []);

  // Extract working directory: prefer relay-resolved context, fall back to URL
  const workingDirectory = (() => {
    const sgResolved = (
      window as Window & { __SG_RESOLVED?: { path?: string; role?: string } }
    ).__SG_RESOLVED;
    if (sgResolved?.path) return sgResolved.path;

    const rawPath = location.pathname.replace("/projects", "");
    if (!rawPath) return undefined;

    // URL decode the path
    const decodedPath = decodeURIComponent(rawPath);

    // Normalize Windows paths (remove leading slash from /C:/... format)
    return normalizeWindowsPath(decodedPath);
  })();

  // File change polling — only `setExternallyModified` is read here; the
  // other return values are intentionally unused (the polling fires the
  // setter via the callback below).
  const { setExternallyModified } = useFilePolling({
    projectPath: workingDirectory,
    intervalMs: 3000,
    onFilesChanged: (changed, _added, deleted) => {
      setSidebarRefreshKey((k) => k + 1);
      if (editingFile) {
        const editingRel = editingFile.path;
        if (
          changed.some((f) => editingRel.endsWith(f)) ||
          deleted.some((f) => editingRel.endsWith(f))
        ) {
          setExternallyModified(editingFile.path);
        }
      }
      if (contextFiles.size > 0) {
        const stale = changed.filter((f) =>
          [...contextFiles].some((cf) => cf.endsWith(f)),
        );
        if (stale.length > 0) {
          setStaleFiles((prev) => [...new Set([...prev, ...stale])]);
        }
      }
    },
  });

  // Get sessionId and role from query parameters or relay context. The old
  // ?view=history query parameter is intentionally no longer read — the
  // prior-sessions list UI was removed entirely.
  const sessionId = searchParams.get("sessionId");
  const roleFile =
    searchParams.get("role") ||
    (window as Window & { __SG_RESOLVED?: { role?: string } }).__SG_RESOLVED
      ?.role ||
    null;

  // Load role context file if specified in URL.
  // Try .claude/agents/ (native Claude Code convention) first, then agents/ (legacy).
  useEffect(() => {
    if (roleFile && workingDirectory && !activeContext) {
      const nativePath = `${workingDirectory}/.claude/agents/${roleFile}`;
      const legacyPath = `${workingDirectory}/agents/${roleFile}`;

      const tryLoadRole = async () => {
        for (const rolePath of [nativePath, legacyPath]) {
          try {
            const res = await fetch(`/api/files/read?path=${encodeURIComponent(rolePath)}`);
            if (!res.ok) continue;
            const data = await res.json();
            if (!data) continue;
            const name = roleFile.replace(/\.md$/, "").replace(/[-_]/g, " ");
            setActiveContext({
              name,
              filename: roleFile,
              path: rolePath,
              content: data.content,
            });
            setContextFiles(new Set([rolePath]));
            setContextFilesList([
              { path: rolePath, name: roleFile, touchedAt: Date.now() },
            ]);
            setContextChecked(true);
            return;
          } catch {
            // Try next path
          }
        }
        setContextChecked(true);
      };
      tryLoadRole();
    }
  }, [roleFile, workingDirectory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute current agent URL from relay context for the agent switcher
  const currentAgentUrl = (() => {
    const sg = (window as Window & { __SG?: { slug?: string; segment?: string; project?: string; role?: string } }).__SG;
    if (!sg?.slug || !sg?.segment) return undefined;
    return `/vm/${sg.slug}/${sg.segment}/`;
  })();

  // Record this agent as recently used
  useEffect(() => {
    const sg = (window as Window & { __SG?: { slug?: string; segment?: string; project?: string; role?: string } }).__SG;
    if (!sg?.slug || !sg?.segment || !sg?.project) return;
    fleet.recordAgent({
      url: `/vm/${sg.slug}/${sg.segment}/`,
      label: `${sg.project}-${sg.role || "default"}`,
      connectorName: sg.slug,
      project: sg.project,
      role: sg.role || "default",
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show context picker for new sessions — skip if role is already set via URL
  useEffect(() => {
    if (
      !sessionId &&
      workingDirectory &&
      !contextChecked &&
      !roleFile
    ) {
      setShowContextPicker(true);
    }
  }, [sessionId, workingDirectory, contextChecked, roleFile]);

  // Auto-resume last session on page load (no sessionId in URL).
  // ?new=1 skips resume and starts a fresh session.
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      // Strip ?new=1 from URL so a refresh doesn't keep forcing new sessions
      const params = new URLSearchParams(searchParams);
      params.delete("new");
      navigate({ search: params.toString() }, { replace: true });
      return; // skip resume — start fresh
    }
    if (sessionId || !workingDirectory) return;
    const lastSessionUrl = new URL("/api/session/last", window.location.origin);
    lastSessionUrl.searchParams.set("projectPath", workingDirectory);
    if (roleFile) {
      lastSessionUrl.searchParams.set("role", roleFile);
    }
    fetch(lastSessionUrl.toString())
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.session?.sessionId) {
          const params = new URLSearchParams(searchParams);
          params.set("sessionId", data.session.sessionId);
          if (data.session.role) {
            params.set("role", data.session.role);
          }
          navigate({ search: params.toString() }, { replace: true });
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- WebSocket session hook ---
  const ws = useWebSocketSession();

  // Connect on mount
  useEffect(() => {
    ws.connect();
  }, [ws.connect]);

  // Permission mode state management
  const { permissionMode, setPermissionMode } = usePermissionMode();

  // Get encoded name for current working directory
  const getEncodedName = useCallback(() => {
    if (!workingDirectory || !projects.length) {
      return null;
    }

    const project = projects.find((p) => p.path === workingDirectory);

    // Normalize paths for comparison (handle Windows path issues)
    const normalizedWorking = normalizeWindowsPath(workingDirectory);
    const normalizedProject = projects.find(
      (p) => normalizeWindowsPath(p.path) === normalizedWorking,
    );

    // Use normalized result if exact match fails
    const finalProject = project || normalizedProject;

    return finalProject?.encodedName || null;
  }, [workingDirectory, projects]);

  // Load conversation history if sessionId is provided. The backend
  // returns pre-replayed Frame[] from a headless FrameEmitter (see
  // backend/history/conversationLoader.ts).
  const {
    frames: historyFrames,
    loading: historyLoading,
    error: historyError,
    sessionId: loadedSessionId,
  } = useAutoHistoryLoader(
    getEncodedName() || undefined,
    sessionId || undefined,
  );

  // Initialize chat state — input/loading/session only; rows live in
  // the frame-native reducer below.
  const {
    input,
    isLoading,
    currentSessionId,
    setInput,
    setCurrentSessionId,
    updateStatus,
    currentStatus,
    clearInput,
    resetRequestState,
    startRequest,
  } = useChatState({
    initialSessionId: loadedSessionId || undefined,
  });

  // Frame-native scrollback — the single source of truth for rows.
  const frameChat = useFrameChatState();

  // Hydrate rows from the backend's replayed Frame[] whenever a different
  // historical session lands. Guard against re-hydrating across re-renders
  // of the same array reference; only reload when the loaded sessionId
  // actually changes so live frames already in the reducer aren't wiped.
  const hydratedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loadedSessionId) return;
    if (hydratedSessionIdRef.current === loadedSessionId) return;
    hydratedSessionIdRef.current = loadedSessionId;
    frameChat.loadFrames(historyFrames);
  }, [loadedSessionId, historyFrames, frameChat]);

  // Surface real history-load failures as a notice frame instead of
  // replacing the whole chat view with a full-screen error. That way the
  // permission-mode announcement and any live frames still show up, and
  // the user can start a new message immediately.
  const announcedHistoryErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!historyError) return;
    if (announcedHistoryErrorRef.current === historyError) return;
    announcedHistoryErrorRef.current = historyError;
    // Inlined synthesizer — emitLocalNotice is declared below and this
    // effect only needs to run on transitions into an error state.
    const frame: ErrorFrame = {
      id: `local-${Math.random().toString(36).slice(2, 10)}`,
      seq: 0,
      ts: Date.now(),
      type: "error",
      category: "notice",
      message: `History couldn't be loaded: ${historyError}`,
    };
    frameChat.addFrame(frame);
  }, [historyError, frameChat]);

  // Local notice helper — surfaces client-side events (permission-mode
  // announcement, /reset banner, etc.) on the same scrollback the backend
  // feeds, so we don't need a second state store. Uses the ErrorFrame
  // "notice" category so the row renders as a neutral notice box, not a
  // red error card.
  const emitLocalNotice = useCallback(
    (message: string) => {
      const frame: ErrorFrame = {
        id: `local-${Math.random().toString(36).slice(2, 10)}`,
        seq: 0,
        ts: Date.now(),
        type: "error",
        category: "notice",
        message,
      };
      frameChat.addFrame(frame);
    },
    [frameChat],
  );

  // Save session when a new sessionId is received from Claude
  useEffect(() => {
    if (currentSessionId && workingDirectory) {
      fetch("/api/session/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: currentSessionId,
          projectPath: workingDirectory,
          role: roleFile || undefined,
        }),
      }).catch(() => {});
    }
  }, [currentSessionId, workingDirectory, roleFile]);

  // Wire WebSocket callbacks. Frame-native: every inbound frame flows
  // straight into the reducer via `onFrame`; protocol-only side effects
  // (session id, slash commands, file delivery refresh, turn completion,
  // transient status line) come through their own callbacks.
  useEffect(() => {
    ws.setCallbacks({
      onFrame: frameChat.addFrame,
      onSessionId: (sid: string) => {
        setCurrentSessionId(sid);
        sessionStatsRef.current = { ...sessionStatsRef.current, sessionId: sid };
        setSessionStats(sessionStatsRef.current);
      },
      onFileDelivery: () => setSidebarRefreshKey((k) => k + 1),
      onSlashCommands: (cmds: string[]) => {
        const withNative = cmds.includes("reset") ? cmds : ["reset", ...cmds];
        setSlashCommands(withNative);
      },
      onTurnComplete: () => {
        resetRequestState();
      },
      onStatusUpdate: updateStatus,
    });
  }, [
    ws.setCallbacks,
    frameChat.addFrame,
    setCurrentSessionId,
    resetRequestState,
    updateStatus,
  ]);

  // Start/join session once WS is connected and we have roleFile + workingDirectory
  useEffect(() => {
    if (!ws.connected || !roleFile || !workingDirectory) return;
    if (!contextChecked) return;
    if (ws.attached) return; // already in a session
    ws.startSession(roleFile, workingDirectory, activeContext?.content);
  }, [
    ws.connected,
    ws.attached,
    roleFile,
    workingDirectory,
    contextChecked,
    activeContext?.content,
    ws.startSession,
  ]);

  const {
    allowedTools,
    permissionRequest,
    closePermissionRequest,
    allowToolTemporary,
    allowToolPermanent,
    isPermissionMode,
    planModeRequest,
    closePlanModeRequest,
    updatePermissionMode,
  } = usePermissions({
    onPermissionModeChange: setPermissionMode,
  });

  // One-shot permission-mode announcement. Fires once after the WS session
  // attaches so the user sees on load that bypassPermissions is active
  // (our default — see usePermissionMode). Re-announces if the session is
  // restarted (handleNewSession clears this ref). Synthesizes a local
  // notice frame so it joins the scrollback through the same reducer as
  // the live frames.
  const announcedModeRef = useRef(false);
  useEffect(() => {
    if (!ws.attached || announcedModeRef.current) return;
    announcedModeRef.current = true;
    const label: Record<typeof permissionMode, string> = {
      bypassPermissions:
        "Bypass permissions mode — Claude will run tools without asking. Toggle in the input bar if you want prompts.",
      acceptEdits:
        "Accept-edits mode — Claude auto-accepts file edits but still prompts for other tools.",
      plan: "Plan mode — Claude will outline changes and wait for approval before acting.",
      default:
        "Default permission mode — Claude will prompt before running tools.",
    };
    emitLocalNotice(label[permissionMode]);
  }, [ws.attached, permissionMode, emitLocalNotice]);

  // New Session — same logic as the /reset slash command, exposed as a
  // header button so the user isn't required to type anything to start over.
  const handleNewSession = useCallback(() => {
    frameChat.resetFrames();
    if (roleFile && workingDirectory) {
      ws.restartSession(roleFile, workingDirectory);
    }
    announcedModeRef.current = false; // re-announce mode on the next attach
    emitLocalNotice("New session started.");
    setSessionFocusBump((n) => n + 1);
  }, [frameChat, roleFile, workingDirectory, ws.restartSession, emitLocalNotice]);

  const sendMessage = useCallback(
    async (
      messageContent?: string,
      _tools?: string[],
      hideUserMessage = false,
    ) => {
      let content = messageContent || input.trim();
      if (!content && pendingImages.length === 0) return;

      const trimmedLower = content.trim().toLowerCase();

      // /reset — restart session via WebSocket (saves JSONL history)
      if (trimmedLower === "/reset") {
        clearInput();
        frameChat.resetFrames();
        if (roleFile && workingDirectory) {
          ws.restartSession(roleFile, workingDirectory);
        }
        emitLocalNotice("New session started.");
        return;
      }

      // /stop — interrupt Claude immediately
      if (trimmedLower === "/stop") {
        clearInput();
        ws.interrupt();
        resetRequestState();
        emitLocalNotice("Interrupted.");
        return;
      }

      // /btw — send a side-message without interrupting; Claude reads it
      // from the queue when it next checks for input. The backend echoes
      // the message back as a user_message frame once it lands in the
      // queue, so we don't need to pre-render it locally.
      if (trimmedLower.startsWith("/btw ") || trimmedLower === "/btw") {
        const btw = content.trim().slice(4).trim();
        if (!btw) return;
        clearInput();
        ws.sendMessage(btw);
        return;
      }

      // Snapshot the current pending attachments before the async upload
      // loop so the local echo can reference the in-memory blob URLs even
      // after state is cleared. We key off the File objects (not the upload
      // response) so the echo still works if an upload fails — the user
      // sees what they tried to send, and any send-side error surfaces via
      // the error notice path separately.
      const pendingSnapshot = pendingImages;

      // Upload pending files and collect server paths
      const attachmentPaths: string[] = [];
      if (pendingImages.length > 0 && workingDirectory) {
        for (const img of pendingImages) {
          const formData = new FormData();
          formData.append("file", img.file);
          formData.append("workingDirectory", workingDirectory);
          try {
            const res = await fetch("/api/upload", {
              method: "POST",
              body: formData,
            });
            if (res.ok) {
              const data = await res.json();
              attachmentPaths.push(data.path);
            }
          } catch (err) {
            console.error("File upload failed:", err);
          }
        }
        setPendingImages([]);
      }

      // Need either text or attachments
      if (!content && attachmentPaths.length === 0) return;

      // Echo the user's message into scrollback immediately via a
      // client-side UserMessageFrame. The backend will also emit a
      // real user_message frame a beat later, but `useWebSocketSession`
      // swallows that live echo so we don't see a double-row. `hideUserMessage`
      // is used for background continuations (permission "continue", plan
      // "accept") that shouldn't appear in scrollback at all.
      if (!hideUserMessage) {
        const blocks: UserContentBlock[] = [];
        const nonImageNames: string[] = [];
        for (const img of pendingSnapshot) {
          if (img.file.type.startsWith("image/")) {
            // Blob URL survives for the lifetime of the page — good enough
            // for in-session display. History replay of images is a separate
            // problem tracked in the roadmap backlog.
            blocks.push({
              type: "image",
              mimeType: img.file.type,
              dataUrl: img.preview,
            });
          } else {
            nonImageNames.push(img.file.name);
          }
        }
        const prefix =
          nonImageNames.length > 0
            ? `${nonImageNames.map((n) => `[${n}]`).join(" ")}\n`
            : "";
        const text = (prefix + (content || "")).trim();
        if (text) blocks.push({ type: "text", text });
        if (blocks.length > 0) {
          frameChat.addFrame({
            id: `local-user-${Math.random().toString(36).slice(2, 10)}`,
            seq: 0,
            ts: Date.now(),
            type: "user_message",
            content: blocks,
          });
        }
      }

      if (!messageContent) clearInput();

      // No interrupt — the message is queued on the backend and Claude
      // will read it when it next checks its input queue.
      if (!isLoading) {
        startRequest();
      }

      // Send via WebSocket — responses arrive through the callbacks
      ws.sendMessage(
        content,
        attachmentPaths.length > 0 ? attachmentPaths : undefined,
      );
    },
    [
      input,
      isLoading,
      ws,
      roleFile,
      workingDirectory,
      activeContext,
      clearInput,
      startRequest,
      frameChat,
      emitLocalNotice,
      resetRequestState,
      pendingImages,
    ],
  );

  const handleAbort = useCallback(() => {
    ws.interrupt();
    resetRequestState();
  }, [ws, resetRequestState]);

  // Permission request handlers
  const handlePermissionAllow = useCallback(() => {
    if (!permissionRequest) return;

    // Add all patterns temporarily
    let updatedAllowedTools = allowedTools;
    permissionRequest.patterns.forEach((pattern) => {
      updatedAllowedTools = allowToolTemporary(pattern, updatedAllowedTools);
    });

    closePermissionRequest();

    if (currentSessionId) {
      sendMessage("continue", undefined, true);
    }
  }, [
    permissionRequest,
    currentSessionId,
    sendMessage,
    allowedTools,
    allowToolTemporary,
    closePermissionRequest,
  ]);

  const handlePermissionAllowPermanent = useCallback(() => {
    if (!permissionRequest) return;

    // Add all patterns permanently
    let updatedAllowedTools = allowedTools;
    permissionRequest.patterns.forEach((pattern) => {
      updatedAllowedTools = allowToolPermanent(pattern, updatedAllowedTools);
    });

    closePermissionRequest();

    if (currentSessionId) {
      sendMessage("continue", undefined, true);
    }
  }, [
    permissionRequest,
    currentSessionId,
    sendMessage,
    allowedTools,
    allowToolPermanent,
    closePermissionRequest,
  ]);

  const handlePermissionDeny = useCallback(() => {
    closePermissionRequest();
  }, [closePermissionRequest]);

  // Plan mode request handlers
  const handlePlanAcceptWithEdits = useCallback(() => {
    updatePermissionMode("acceptEdits");
    closePlanModeRequest();
    if (currentSessionId) {
      sendMessage("accept", undefined, true);
    }
  }, [
    updatePermissionMode,
    closePlanModeRequest,
    currentSessionId,
    sendMessage,
    allowedTools,
  ]);

  const handlePlanAcceptDefault = useCallback(() => {
    updatePermissionMode("default");
    closePlanModeRequest();
    if (currentSessionId) {
      sendMessage("accept", undefined, true);
    }
  }, [
    updatePermissionMode,
    closePlanModeRequest,
    currentSessionId,
    sendMessage,
    allowedTools,
  ]);

  const handlePlanKeepPlanning = useCallback(() => {
    updatePermissionMode("plan");
    closePlanModeRequest();
  }, [updatePermissionMode, closePlanModeRequest]);

  // Create permission data for inline permission interface
  const permissionData = permissionRequest
    ? {
        patterns: permissionRequest.patterns,
        onAllow: handlePermissionAllow,
        onAllowPermanent: handlePermissionAllowPermanent,
        onDeny: handlePermissionDeny,
      }
    : undefined;

  // Create plan permission data for plan mode interface
  const planPermissionData = planModeRequest
    ? {
        onAcceptWithEdits: handlePlanAcceptWithEdits,
        onAcceptDefault: handlePlanAcceptDefault,
        onKeepPlanning: handlePlanKeepPlanning,
      }
    : undefined;

  const handleSettingsClick = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);

  const handleSettingsClose = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  // Load projects to get encodedName mapping
  useEffect(() => {
    const loadProjects = async () => {
      try {
        const response = await fetch(getProjectsUrl());
        if (response.ok) {
          const data = await response.json();
          setProjects(data.projects || []);
        }
      } catch (error) {
        console.error("Failed to load projects:", error);
      }
    };
    loadProjects();
  }, []);

  // Handle global keyboard shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === KEYBOARD_SHORTCUTS.ABORT && isLoading) {
        e.preventDefault();
        handleAbort();
      }
    };

    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, [isLoading, handleAbort]);

  const isMobile = useIsMobile();

  const handleFileSelect = (path: string, name: string) => {
    setEditingFile({ path, name });
    setShowArchViewer(false);
    // On mobile the panels are mutually exclusive — opening a file should
    // hide the file tree so the editor takes the screen.
    if (isMobile) setShowSidebar(false);
  };

  // Derive the active mobile tab from existing layout state. Single source
  // of truth — desktop keeps using these flags directly, mobile just maps
  // them onto a tab enum.
  const mobileTab: MobileTab = showAgents
    ? "agents"
    : showArchViewer
      ? "arch"
      : editingFile
        ? "editor"
        : showSidebar
          ? "files"
          : "chat";

  const handleMobileTabSelect = useCallback(
    (tab: MobileTab) => {
      setShowSidebar(tab === "files");
      setShowArchViewer(tab === "arch");
      setShowAgents(tab === "agents");
      if (tab !== "editor") setEditingFile(null);
      // Selecting "chat" while a file is open keeps the file in memory but
      // collapses to chat — same as desktop behavior with both flags off.
    },
    [],
  );

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-900 transition-colors duration-300 overflow-hidden">
      {/* Header — always at top. The back-arrow chevrons that used to sit
          here (one for history view, one for loaded prior conversations) have
          been removed along with the prior-sessions list page. */}
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0 border-b border-slate-200 dark:border-slate-700 min-w-0 gap-2">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center min-w-0">
              <span className="text-slate-800 dark:text-slate-100 text-lg sm:text-2xl font-bold tracking-tight px-1 -mx-1 flex-shrink-0">
                SpAIglass
              </span>
              {(() => {
                // Big-font project/role display. Project = basename of the
                // working directory; role = activeContext.name when loaded,
                // otherwise a humanized fallback from the raw roleFile (e.g.
                // "dev-ops.md" → "dev ops"). Path lives in the subline below.
                const projectBase = workingDirectory
                  ? workingDirectory
                      .replace(/\/+$/, "")
                      .split(/[\\/]/)
                      .filter(Boolean)
                      .pop() || workingDirectory
                  : null;
                const roleLabel =
                  activeContext?.name ||
                  (roleFile
                    ? roleFile.replace(/\.md$/, "").replace(/[-_]/g, " ")
                    : null);
                if (!projectBase && !roleLabel) return null;
                return (
                  <span className="ml-3 flex items-center min-w-0 text-lg sm:text-2xl font-bold tracking-tight truncate">
                    {projectBase && (
                      <span
                        className="text-blue-500 dark:text-blue-400 truncate"
                        title={workingDirectory || projectBase}
                      >
                        {projectDisplayNames[projectBase] || getLocalDisplayName(projectBase) || projectBase}
                      </span>
                    )}
                    {projectBase && roleLabel && (
                      <span className="mx-2 text-slate-400 flex-shrink-0">
                        /
                      </span>
                    )}
                    {roleLabel && (
                      <span className="text-emerald-500 dark:text-emerald-400 truncate">
                        {roleLabel}
                      </span>
                    )}
                  </span>
                );
              })()}
            </div>
            {workingDirectory && (
              <div
                className="text-xs font-mono text-slate-500 dark:text-slate-400 max-w-full block text-left select-text cursor-text"
              >
                {workingDirectory.replace(/^\/home\/[^/]+/, "~")}
                {vmConfig && (vmConfig.vmName || vmConfig.ipv4) && (
                  <span className="ml-2 text-slate-400 dark:text-slate-500">
                    @ {vmConfig.vmName}
                    {vmConfig.ipv4 && (
                      <span className="ml-1 text-slate-500 dark:text-slate-400">
                        ({vmConfig.ipv4})
                      </span>
                    )}
                  </span>
                )}
                {(currentSessionId || sessionId) && (
                  <span className="ml-2 text-slate-400">
                    {currentSessionId || sessionId}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {/* Agent switcher — middle section (desktop only) */}
        {!isMobile && fleet.isRelay && (
          <AgentSwitcher
            recentAgents={fleet.recentAgents}
            roles={fleet.roles}
            connectors={fleet.connectors}
            loading={fleet.loading}
            isRelay={fleet.isRelay}
            currentUrl={currentAgentUrl}
          />
        )}
        <div className="flex items-center gap-3">
          {/* Folder/Arch/History buttons live in the bottom MobileTabBar on
              mobile, so the header right cluster collapses to just Settings. */}
          {!isMobile && (
            <>
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                className={`p-2 rounded-lg border transition-all duration-200 ${
                  showSidebar
                    ? "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400"
                    : "bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800"
                }`}
                title="Toggle file browser"
              >
                <FolderIcon className="w-5 h-5" />
              </button>
              <button
                onClick={() => {
                  const opening = !showArchViewer;
                  setShowArchViewer(opening);
                  if (opening) {
                    setEditingFile(null);
                  }
                }}
                className={`p-2 rounded-lg border transition-all duration-200 ${
                  showArchViewer
                    ? "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400"
                    : "bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800"
                }`}
                title="Architecture viewer"
              >
                <CubeTransparentIcon className="w-5 h-5" />
              </button>
            </>
          )}
          <button
            onClick={handleNewSession}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800 transition-all duration-200"
            title="New session"
            aria-label="New session"
          >
            <PlusCircleIcon className="w-5 h-5" />
          </button>
          <SettingsButton onClick={handleSettingsClick} />
        </div>
      </div>

      {/* Body — horizontal split on desktop; on mobile only the panel for
          the active MobileTab is rendered, full-width, with the tab bar
          mounted at the bottom of the outer column. */}
      <div className="flex-1 flex overflow-hidden">
        {/* File Sidebar — independent left panel, stays open alongside everything */}
        {showSidebar &&
          workingDirectory &&
          (!isMobile || mobileTab === "files") && (
            <div className={isMobile ? "flex-1 min-w-0" : "w-56 flex-shrink-0 border-r border-slate-200 dark:border-slate-700"}>
              <FileSidebar
                key={sidebarRefreshKey}
                projectPath={workingDirectory}
                onFileSelect={handleFileSelect}
                contextFiles={contextFiles}
                contextFilesList={contextFilesList}
                sessionStats={sessionStats}
                slashCommands={slashCommands}
                activeRole={roleFile || undefined}
              />
            </div>
          )}

        {/* Mobile agents full-page view */}
        {isMobile && mobileTab === "agents" && (
          <AgentPickerFullPage
            recentAgents={fleet.recentAgents}
            roles={fleet.roles}
            connectors={fleet.connectors}
            loading={fleet.loading}
          />
        )}

        {/* Right panel slot — ONE of: arch viewer or file editor.
            Both get flex-1 (wide). They replace each other — never stack side by side. */}
        {showArchViewer &&
        workingDirectory &&
        (!isMobile || mobileTab === "arch") ? (
          <div className="flex-1 min-w-0 overflow-hidden border-r border-slate-200 dark:border-slate-700">
            <ArchitectureViewer projectPath={workingDirectory} />
          </div>
        ) : editingFile && (!isMobile || mobileTab === "editor") ? (
          <div className="flex-1 min-w-0 overflow-hidden border-r border-slate-200 dark:border-slate-700">
            <FileEditor
              filePath={editingFile.path}
              fileName={editingFile.name}
              onClose={() => setEditingFile(null)}
            />
          </div>
        ) : null}

        {/* Chat panel — hidden on mobile when another tab is active */}
        <div
          className={`${
            isMobile
              ? mobileTab === "chat"
                ? "flex-1"
                : "hidden"
              : editingFile || showArchViewer
                ? "w-[450px] flex-shrink-0"
                : "flex-1"
          } min-w-0 flex flex-col overflow-hidden`}
        >
          <div className="flex-1 flex flex-col overflow-hidden p-3 sm:p-4">
            {historyLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin mx-auto mb-4"></div>
                  <p className="text-slate-600 dark:text-slate-400">
                    Loading conversation history...
                  </p>
                </div>
              </div>
            ) : (
              <>
                <StaleContextBanner
                  staleFiles={staleFiles}
                  onReRead={(filePath) => {
                    // Send a message asking Claude to re-read the file
                    const name = filePath.split("/").pop() || filePath;
                    sendMessage(`Please re-read the file: ${name}`);
                    setStaleFiles((prev) => prev.filter((f) => f !== filePath));
                  }}
                  onDismiss={() => setStaleFiles([])}
                />
                <FrameChatView
                  rows={frameChat.state.rows}
                  toolCalls={frameChat.state.toolCalls}
                  isLoading={isLoading}
                  currentStatus={currentStatus}
                  userLogin={ws.login}
                  onOpenFile={(path, name) => {
                    setShowSidebar(true);
                    setEditingFile({ path, name });
                    setShowArchViewer(false);
                  }}
                  onToolResult={(requestId, status, data, reason) => {
                    // Tell the backend what the user picked.
                    ws.sendToolResult(requestId, status, data, reason);
                    // Optimistically flip the matching interactive row to
                    // resolved so a stray replay/reconnect can't re-open
                    // the widget. The backend will confirm with a real
                    // interactive_resolved frame shortly.
                    frameChat.addFrame({
                      id: `local-resolved-${Math.random().toString(36).slice(2, 10)}`,
                      seq: 0,
                      ts: Date.now(),
                      type: "interactive_resolved",
                      requestId,
                      resolution: status,
                    });
                  }}
                  onSubmitText={(text) => sendMessage(text)}
                />

                <ChatInput
                  input={input}
                  isLoading={isLoading}
                  onInputChange={setInput}
                  onSubmit={() => sendMessage()}
                  onAbort={handleAbort}
                  permissionMode={permissionMode}
                  onPermissionModeChange={setPermissionMode}
                  slashCommands={slashCommands}
                  showPermissions={isPermissionMode}
                  permissionData={permissionData}
                  planPermissionData={planPermissionData}
                  thinkingLevel={thinkingLevel}
                  onThinkingLevelChange={setThinkingLevel}
                  // Layout-reshape signature so ChatInput re-focuses the
                  // textarea after any panel toggle. Each contributing flag
                  // gets its own bit so the integer changes whenever any of
                  // them flip:
                  //   • arch viewer / file editor — collapse the chat panel
                  //     between w-[450px] and flex-1
                  //   • file sidebar — narrows the chat panel by the
                  //     w-56 left column
                  //   • settings modal — toggles `document.body.style.overflow`
                  //     which reflows the page; without a refocus the caret
                  //     ends up clipped behind the chat scrollback
                  focusTrigger={
                    (showArchViewer ? 1 : 0) +
                    (editingFile ? 2 : 0) +
                    (showSidebar ? 4 : 0) +
                    (isSettingsOpen ? 8 : 0) +
                    sessionFocusBump * 16
                  }
                  pendingImages={pendingImages}
                  onImageAdd={(files) => {
                    const newImages = files.map((f) => ({
                      file: f,
                      preview: URL.createObjectURL(f),
                    }));
                    setPendingImages((prev) => [...prev, ...newImages]);
                  }}
                  onImageRemove={(index) => {
                    setPendingImages((prev) => {
                      URL.revokeObjectURL(prev[index].preview);
                      return prev.filter((_, i) => i !== index);
                    });
                  }}
                  onMentionTrigger={(query, rect) => {
                    setMentionState({
                      query,
                      position: {
                        top: window.innerHeight - rect.top + 8,
                        left: rect.left,
                      },
                    });
                  }}
                  onMentionClose={() => setMentionState(null)}
                  mentionDropdown={
                    mentionState && workingDirectory ? (
                      <FileMention
                        projectPath={workingDirectory}
                        contextFiles={contextFiles}
                        query={mentionState.query}
                        position={mentionState.position}
                        onSelect={(filePath) => {
                          const atIndex = input.lastIndexOf("@");
                          if (atIndex !== -1) {
                            const newInput =
                              input.slice(0, atIndex) + filePath + " ";
                            setInput(newInput);
                          }
                          setMentionState(null);
                        }}
                        onClose={() => setMentionState(null)}
                      />
                    ) : undefined
                  }
                />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Mobile bottom tab bar — only mounts on mobile breakpoint */}
      {isMobile && (
        <MobileTabBar
          activeTab={mobileTab}
          editorEnabled={!!editingFile}
          onSelect={handleMobileTabSelect}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={handleSettingsClose} projectPath={workingDirectory || undefined} onRoleCreated={fleet.fetchFleet} />

      {/* Context Picker Dialog */}
      {showContextPicker && workingDirectory && (
        <NewSessionDialog
          projectPath={workingDirectory}
          onSelect={async (ctx) => {
            setShowContextPicker(false);
            setContextChecked(true);
            if (ctx) {
              // Load full content
              try {
                const res = await fetch(
                  `/api/files/read?path=${encodeURIComponent(ctx.path)}`,
                );
                if (res.ok) {
                  const data = await res.json();
                  setActiveContext({ ...ctx, content: data.content });
                  setContextFiles(new Set([ctx.path]));
                } else {
                  setActiveContext(ctx);
                  setContextFiles(new Set([ctx.path]));
                }
              } catch {
                setActiveContext(ctx);
                setContextFiles(new Set([ctx.path]));
              }
            }
          }}
          onCancel={() => {
            setShowContextPicker(false);
            setContextChecked(true);
          }}
        />
      )}
    </div>
  );
}
