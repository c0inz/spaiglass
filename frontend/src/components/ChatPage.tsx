import { useEffect, useCallback, useState, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeftIcon, FolderIcon, KeyIcon, CubeTransparentIcon } from "@heroicons/react/24/outline";
import type {
  ChatMessage,
  ProjectInfo,
  SessionStats,
} from "../types";
import { useChatState } from "../hooks/chat/useChatState";
import { usePermissions } from "../hooks/chat/usePermissions";
import { usePermissionMode } from "../hooks/chat/usePermissionMode";
import { useAutoHistoryLoader } from "../hooks/useHistoryLoader";
import { useWebSocketSession } from "../hooks/useWebSocketSession";
import { SettingsButton } from "./SettingsButton";
import { SettingsModal } from "./SettingsModal";
import { HistoryButton } from "./chat/HistoryButton";
import { ChatInput } from "./chat/ChatInput";
import { ChatMessages } from "./chat/ChatMessages";
import { HistoryView } from "./HistoryView";
import { FileSidebar } from "./FileSidebar";
import { FileEditor } from "./FileEditor";
import { FileMention } from "./FileMention";
import { NewSessionDialog } from "./NewSessionDialog";
import { StaleContextBanner } from "./StaleContextBanner";
import { ArchitectureViewer } from "./ArchitectureViewer";
import { MobileTabBar, type MobileTab } from "./MobileTabBar";
import { SecretsPanel } from "./SecretsPanel";
import { useIsMobile } from "../hooks/useIsMobile";
import { useFilePolling } from "../hooks/useFilePolling";
import { getProjectsUrl } from "../config/api";
import { KEYBOARD_SHORTCUTS } from "../utils/constants";
import { normalizeWindowsPath } from "../utils/pathUtils";
import { useVmConfig } from "../hooks/useVmConfig";

export function ChatPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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
  const [showSecrets, setShowSecrets] = useState(false);
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
  // useVmConfig() side-effects (logging, telemetry) are still useful even
  // though no consumer reads its return value here. Call it for the effect.
  void useVmConfig();

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

  // Get current view, sessionId, and role from query parameters or relay context
  const currentView = searchParams.get("view");
  const sessionId = searchParams.get("sessionId");
  const roleFile =
    searchParams.get("role") ||
    (window as Window & { __SG_RESOLVED?: { role?: string } }).__SG_RESOLVED
      ?.role ||
    null;
  const isHistoryView = currentView === "history";
  const isLoadedConversation = !!sessionId && !isHistoryView;

  // Load role context file if specified in URL
  useEffect(() => {
    if (roleFile && workingDirectory && !activeContext) {
      const rolePath = `${workingDirectory}/agents/${roleFile}`;
      fetch(`/api/files/read?path=${encodeURIComponent(rolePath)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) {
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
          }
        })
        .catch(() => {});
    }
  }, [roleFile, workingDirectory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show context picker for new sessions — skip if role is already set via URL
  useEffect(() => {
    if (
      !isHistoryView &&
      !sessionId &&
      workingDirectory &&
      !contextChecked &&
      !roleFile
    ) {
      setShowContextPicker(true);
    }
  }, [isHistoryView, sessionId, workingDirectory, contextChecked, roleFile]);

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
    if (sessionId || isHistoryView || !workingDirectory) return;
    fetch(
      `/api/session/last?projectPath=${encodeURIComponent(workingDirectory)}`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.session?.sessionId) {
          const params = new URLSearchParams(searchParams);
          params.set("sessionId", data.session.sessionId);
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

  // Load conversation history if sessionId is provided
  const {
    messages: historyMessages,
    loading: historyLoading,
    error: historyError,
    sessionId: loadedSessionId,
  } = useAutoHistoryLoader(
    getEncodedName() || undefined,
    sessionId || undefined,
  );

  // Initialize chat state with loaded history
  const {
    messages,
    input,
    isLoading,
    currentSessionId,
    currentAssistantMessage,
    setMessages,
    setInput,
    setCurrentSessionId,
    setCurrentAssistantMessage,
    addMessage,
    updateLastMessage,
    clearInput,
    resetRequestState,
    startRequest,
  } = useChatState({
    initialMessages: historyMessages,
    initialSessionId: loadedSessionId || undefined,
  });

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

  // Wire WebSocket callbacks so the hook can pipe messages into useChatState
  useEffect(() => {
    ws.setCallbacks({
      addMessage,
      updateLastMessage,
      setCurrentAssistantMessage,
      currentAssistantMessage,
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
    });
  }, [addMessage, updateLastMessage, setCurrentAssistantMessage, currentAssistantMessage, ws.setCallbacks, setCurrentSessionId, resetRequestState]);

  // Start/join session once WS is connected and we have roleFile + workingDirectory
  useEffect(() => {
    if (!ws.connected || !roleFile || !workingDirectory) return;
    if (ws.attached) return; // already in a session
    ws.startSession(roleFile, workingDirectory, activeContext?.content);
  }, [ws.connected, ws.attached, roleFile, workingDirectory, activeContext?.content, ws.startSession]);

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

  const sendMessage = useCallback(
    async (
      messageContent?: string,
      _tools?: string[],
      hideUserMessage = false,
    ) => {
      let content = messageContent || input.trim();
      if (!content && pendingImages.length === 0) return;

      // /reset — restart session via WebSocket (saves JSONL history)
      if (content.trim().toLowerCase() === "/reset") {
        clearInput();
        setMessages([]);
        if (roleFile && workingDirectory) {
          ws.restartSession(roleFile, workingDirectory);
        }
        addMessage({
          type: "system",
          subtype: "abort",
          message: "Session reset. Send a message to start a new session.",
          timestamp: Date.now(),
        });
        return;
      }

      // Upload pending files and collect server paths
      const attachmentPaths: string[] = [];
      const attachmentNames: string[] = [];
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
              attachmentNames.push(data.filename);
            }
          } catch (err) {
            console.error("File upload failed:", err);
          }
        }
        setPendingImages([]);
      }

      // Need either text or attachments
      if (!content && attachmentPaths.length === 0) return;

      // Prepend context file content on first message of session
      if (!ws.sessionId && activeContext?.content) {
        content = `[Session Context: ${activeContext.filename}]\n\n${activeContext.content}\n\n---\n\n${content}`;
      }

      // Only add user message to chat if not hidden
      if (!hideUserMessage) {
        const displayContent =
          attachmentNames.length > 0
            ? `${attachmentNames.map((n) => `[${n}]`).join(" ")}\n${content || ""}`
            : content;
        const userMessage: ChatMessage = {
          type: "chat",
          role: "user",
          content: displayContent.trim(),
          timestamp: Date.now(),
        };
        addMessage(userMessage);
      }

      if (!messageContent) clearInput();

      // If Claude is currently responding, interrupt first
      if (isLoading) {
        ws.interrupt();
      }
      startRequest();

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
      addMessage,
      setMessages,
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

  const handleHistoryClick = useCallback(() => {
    const searchParams = new URLSearchParams();
    searchParams.set("view", "history");
    navigate({ search: searchParams.toString() });
  }, [navigate]);

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

  const handleBackToChat = useCallback(() => {
    navigate({ search: "" });
  }, [navigate]);

  const handleBackToHistory = useCallback(() => {
    const searchParams = new URLSearchParams();
    searchParams.set("view", "history");
    navigate({ search: searchParams.toString() });
  }, [navigate]);

  const handleBackToProjectChat = useCallback(() => {
    if (workingDirectory) {
      navigate(`/projects${workingDirectory}`);
    }
  }, [navigate, workingDirectory]);

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
    setShowSecrets(false);
    // On mobile the panels are mutually exclusive — opening a file should
    // hide the file tree so the editor takes the screen.
    if (isMobile) setShowSidebar(false);
  };

  // Derive the active mobile tab from existing layout state. Single source
  // of truth — desktop keeps using these flags directly, mobile just maps
  // them onto a tab enum.
  const mobileTab: MobileTab = isHistoryView
    ? "history"
    : showArchViewer
      ? "arch"
      : showSecrets
        ? "secrets"
        : editingFile
          ? "editor"
          : showSidebar
            ? "files"
            : "chat";

  const handleMobileTabSelect = useCallback(
    (tab: MobileTab) => {
      if (tab === "history") {
        // History lives in URL state. Going to history clears the panels so
        // returning to chat lands cleanly.
        setShowSidebar(false);
        setShowArchViewer(false);
        handleHistoryClick();
        return;
      }
      // Any non-history tab leaves the history view if we're in it.
      if (isHistoryView) navigate({ search: "" });
      setShowSidebar(tab === "files");
      setShowArchViewer(tab === "arch");
      setShowSecrets(tab === "secrets");
      if (tab !== "editor") setEditingFile(null);
      // Selecting "chat" while a file is open keeps the file in memory but
      // collapses to chat — same as desktop behavior with both flags off.
    },
    [handleHistoryClick, isHistoryView, navigate],
  );

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-900 transition-colors duration-300 overflow-hidden">
      {/* Header — always at top */}
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0 border-b border-slate-200 dark:border-slate-700 min-w-0 gap-2">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          {isHistoryView && (
            <button
              onClick={handleBackToChat}
              className="p-2 rounded-lg bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 transition-all duration-200 backdrop-blur-sm shadow-sm hover:shadow-md"
              aria-label="Back to chat"
            >
              <ChevronLeftIcon className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            </button>
          )}
          {isLoadedConversation && (
            <button
              onClick={handleBackToHistory}
              className="p-2 rounded-lg bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 transition-all duration-200 backdrop-blur-sm shadow-sm hover:shadow-md"
              aria-label="Back to history"
            >
              <ChevronLeftIcon className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center min-w-0">
              <span className="text-slate-800 dark:text-slate-100 text-lg sm:text-2xl font-bold tracking-tight px-1 -mx-1 flex-shrink-0">
                SpAIglass
              </span>
              {workingDirectory && (
                <span
                  className="ml-3 text-sm font-medium text-blue-500 dark:text-blue-400 truncate min-w-0"
                  title={workingDirectory}
                >
                  {workingDirectory}
                </span>
              )}
              {activeContext && (
                <span className="ml-2 text-xs font-medium text-emerald-500 dark:text-emerald-400 flex-shrink-0">
                  / {activeContext.name}
                </span>
              )}
              {(isHistoryView || sessionId) && (
                <>
                  <span className="text-slate-400 mx-2 flex-shrink-0">›</span>
                  <span className="text-slate-800 dark:text-slate-100 text-lg font-bold flex-shrink-0">
                    {isHistoryView ? "History" : "Conversation"}
                  </span>
                </>
              )}
            </div>
            {workingDirectory && (
              <button
                onClick={handleBackToProjectChat}
                className="text-xs font-mono text-slate-500 dark:text-slate-400 hover:text-blue-500 transition-colors truncate max-w-full block text-left"
                title={workingDirectory}
              >
                {workingDirectory}
                {sessionId && (
                  <span className="ml-2 text-slate-400">
                    {sessionId.substring(0, 8)}...
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
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
                    setShowSecrets(false);
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
              <button
                onClick={() => {
                  const opening = !showSecrets;
                  setShowSecrets(opening);
                  if (opening) {
                    setShowArchViewer(false);
                    setEditingFile(null);
                  }
                }}
                className={`p-2 rounded-lg border transition-all duration-200 ${
                  showSecrets
                    ? "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400"
                    : "bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800"
                }`}
                title="Secrets vault"
              >
                <KeyIcon className="w-5 h-5" />
              </button>
              {!isHistoryView && <HistoryButton onClick={handleHistoryClick} />}
            </>
          )}
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
              />
            </div>
          )}

        {/* Right panel slot — ONE of: arch viewer, file editor, or secrets.
            Arch & editor get flex-1 (wide). Secrets gets w-56 (narrow, same as files).
            They replace each other — never stack side by side. */}
        {showArchViewer &&
        workingDirectory &&
        (!isMobile || mobileTab === "arch") ? (
          <div className="flex-1 min-w-0 overflow-hidden border-r border-slate-200 dark:border-slate-700">
            <ArchitectureViewer projectPath={workingDirectory} />
          </div>
        ) : showSecrets && (!isMobile || mobileTab === "secrets") ? (
          <div className={isMobile ? "flex-1 min-w-0" : "w-56 flex-shrink-0 border-r border-slate-200 dark:border-slate-700"}>
            <SecretsPanel />
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
              ? mobileTab === "chat" || mobileTab === "history"
                ? "flex-1"
                : "hidden"
              : editingFile || showArchViewer || showSecrets
                ? "w-[450px] flex-shrink-0"
                : "flex-1"
          } min-w-0 flex flex-col overflow-hidden`}
        >
          <div className="flex-1 flex flex-col overflow-hidden p-3 sm:p-4">
            {isHistoryView ? (
              <HistoryView
                workingDirectory={workingDirectory || ""}
                encodedName={getEncodedName()}
                onBack={handleBackToChat}
              />
            ) : historyLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin mx-auto mb-4"></div>
                  <p className="text-slate-600 dark:text-slate-400">
                    Loading conversation history...
                  </p>
                </div>
              </div>
            ) : historyError ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md">
                  <p className="text-red-500 text-xl mb-2">Error</p>
                  <p className="text-slate-600 dark:text-slate-400 text-sm mb-4">
                    {historyError}
                  </p>
                  <button
                    onClick={() => navigate({ search: "" })}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Start New Conversation
                  </button>
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
                <ChatMessages
                  messages={messages}
                  isLoading={isLoading}
                  userLogin={ws.login}
                  onOpenFile={(path, name) => {
                    setShowSidebar(true);
                    setEditingFile({ path, name });
                    setShowArchViewer(false);
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
                  // textarea when arch viewer or file editor toggles. Both
                  // collapse the chat panel between w-[450px] and flex-1.
                  focusTrigger={
                    (showArchViewer ? 1 : 0) + (editingFile ? 2 : 0) + (showSecrets ? 4 : 0)
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
      <SettingsModal isOpen={isSettingsOpen} onClose={handleSettingsClose} />

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
