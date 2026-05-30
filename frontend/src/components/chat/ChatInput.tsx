import React, {
  forwardRef,
  useRef,
  useEffect,
  useState,
  useImperativeHandle,
} from "react";
import { StopIcon, PaperClipIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { UI_CONSTANTS, KEYBOARD_SHORTCUTS } from "../../utils/constants";
import { useEnterBehavior } from "../../hooks/useSettings";
import { PermissionInputPanel } from "./PermissionInputPanel";
import { PlanPermissionInputPanel } from "./PlanPermissionInputPanel";
import type { PermissionMode } from "../../types";

export interface ChatInputHandle {
  getValue(): string;
  setValue(next: string | ((prev: string) => string)): void;
  clear(): void;
  focus(): void;
}

interface PermissionData {
  patterns: string[];
  onAllow: () => void;
  onAllowPermanent: () => void;
  onDeny: () => void;
  getButtonClassName?: (
    buttonType: "allow" | "allowPermanent" | "deny",
    defaultClassName: string,
  ) => string;
  onSelectionChange?: (selection: "allow" | "allowPermanent" | "deny") => void;
  externalSelectedOption?: "allow" | "allowPermanent" | "deny" | null;
}

interface PlanPermissionData {
  onAcceptWithEdits: () => void;
  onAcceptDefault: () => void;
  onKeepPlanning: () => void;
  getButtonClassName?: (
    buttonType: "acceptWithEdits" | "acceptDefault" | "keepPlanning",
    defaultClassName: string,
  ) => string;
  onSelectionChange?: (
    selection: "acceptWithEdits" | "acceptDefault" | "keepPlanning",
  ) => void;
  externalSelectedOption?:
    | "acceptWithEdits"
    | "acceptDefault"
    | "keepPlanning"
    | null;
}

interface ChatInputProps {
  isLoading: boolean;
  currentRequestId?: string | null;
  onSubmit: () => void;
  onAbort: () => void;
  // Permission mode props
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  showPermissions?: boolean;
  permissionData?: PermissionData;
  planPermissionData?: PlanPermissionData;
  // @-mention
  mentionDropdown?: React.ReactNode;
  onMentionTrigger?: (query: string, rect: DOMRect) => void;
  onMentionClose?: () => void;
  // Image upload
  pendingImages?: { file: File; preview: string }[];
  onImageAdd?: (files: File[]) => void;
  onImageRemove?: (index: number) => void;
  // Thinking level
  thinkingLevel?: "off" | "brief" | "extended" | "auto";
  onThinkingLevelChange?: (
    level: "off" | "brief" | "extended" | "auto",
  ) => void;
  // Slash commands from SDK
  slashCommands?: string[];
  // Re-asserts focus on the textarea whenever this value changes. ChatPage
  // bumps it when layout-affecting state (arch viewer, file editor) toggles,
  // so closing those panels returns the cursor to the input.
  focusTrigger?: number;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      isLoading,
      onSubmit,
      onAbort,
      permissionMode,
      onPermissionModeChange,
      showPermissions = false,
      permissionData,
      planPermissionData,
      mentionDropdown,
      onMentionTrigger,
      onMentionClose,
      pendingImages,
      onImageAdd,
      onImageRemove,
      thinkingLevel = "auto",
      onThinkingLevelChange,
      slashCommands = [],
      focusTrigger = 0,
    },
    ref,
  ) {
    // Input value lives here so keystrokes don't re-render the parent
    // (ChatPage) and the entire chat transcript below it. The parent reads
    // and writes via the imperative ChatInputHandle exposed below.
    const [input, setInput] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isComposing, setIsComposing] = useState(false);
    const [slashMenu, setSlashMenu] = useState<{ query: string } | null>(null);
    const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
    const { enterBehavior } = useEnterBehavior();

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => input,
        setValue: (next) => {
          setInput((prev) => (typeof next === "function" ? next(prev) : next));
        },
        clear: () => setInput(""),
        focus: () => inputRef.current?.focus({ preventScroll: true }),
      }),
      [input],
    );

    // Focus input when not loading and not in permission mode. focusTrigger is
    // bumped by ChatPage on layout-state changes (arch viewer / file editor /
    // file sidebar / settings modal) so the cursor returns to the textarea
    // after the chat panel reshapes.
    useEffect(() => {
      if (isLoading || showPermissions) return;
      const raf = requestAnimationFrame(() => {
        inputRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(raf);
    }, [isLoading, showPermissions, focusTrigger]);

    // Universal refocus: when focus falls to <body> (e.g. a modal unmounts,
    // a dialog closes, a dropdown disappears), automatically return focus to
    // the textarea. Skip when the user just clicked a non-focusable control
    // (tabs, icon buttons) — stealing focus back swallows their keystrokes.
    useEffect(() => {
      let timer: ReturnType<typeof setTimeout>;
      let lastPointerDown = 0;
      const handlePointerDown = () => {
        lastPointerDown = Date.now();
      };
      const handleFocusOut = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const active = document.activeElement;
          const recentClick = Date.now() - lastPointerDown < 300;
          if (
            document.hasFocus() &&
            (active === document.body || active === document.documentElement) &&
            !isLoading &&
            !showPermissions &&
            !recentClick
          ) {
            inputRef.current?.focus({ preventScroll: true });
          }
        }, 80);
      };
      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("focusout", handleFocusOut);
      return () => {
        document.removeEventListener("pointerdown", handlePointerDown, true);
        document.removeEventListener("focusout", handleFocusOut);
        clearTimeout(timer);
      };
    }, [isLoading, showPermissions]);

    // Auto-resize textarea
    useEffect(() => {
      const textarea = inputRef.current;
      if (textarea) {
        textarea.style.height = "auto";
        const computedStyle = getComputedStyle(textarea);
        const maxHeight =
          parseInt(computedStyle.maxHeight, 10) ||
          UI_CONSTANTS.TEXTAREA_MAX_HEIGHT;
        const scrollHeight = Math.min(textarea.scrollHeight, maxHeight);
        textarea.style.height = `${scrollHeight}px`;
      }
    }, [input]);

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      onSubmit();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Permission mode toggle: Ctrl+Shift+M (all platforms)
      if (
        e.key === KEYBOARD_SHORTCUTS.PERMISSION_MODE_TOGGLE &&
        e.shiftKey &&
        e.ctrlKey &&
        !e.metaKey && // Avoid conflicts with browser shortcuts on macOS
        !isComposing
      ) {
        e.preventDefault();
        onPermissionModeChange(getNextPermissionMode(permissionMode));
        return;
      }

      // Slash menu keyboard navigation
      if (slashMenu && slashCommands.length > 0) {
        const filtered = slashCommands.filter((cmd) =>
          cmd.toLowerCase().includes(slashMenu.query.toLowerCase()),
        );
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIndex((i) => (i + 1) % filtered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIndex(
            (i) => (i - 1 + filtered.length) % filtered.length,
          );
          return;
        }
        if ((e.key === "Tab" || e.key === "Enter") && filtered.length > 0) {
          e.preventDefault();
          setInput(`/${filtered[slashSelectedIndex]} `);
          setSlashMenu(null);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenu(null);
          return;
        }
      }

      if (e.key === KEYBOARD_SHORTCUTS.SUBMIT && !isComposing) {
        if (enterBehavior === "newline") {
          handleNewlineModeKeyDown(e);
        } else {
          handleSendModeKeyDown(e);
        }
      }
    };

    const handleNewlineModeKeyDown = (
      e: React.KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      // Newline mode: Enter adds newline, Shift+Enter sends
      if (e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
      // Enter is handled naturally by textarea (adds newline)
    };

    const handleSendModeKeyDown = (
      e: React.KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      // Send mode: Enter sends, Shift+Enter adds newline
      if (!e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
      // Shift+Enter is handled naturally by textarea (adds newline)
    };
    const handleCompositionStart = () => {
      setIsComposing(true);
    };

    const handleCompositionEnd = () => {
      // Add small delay to handle race condition between composition and keydown events
      setTimeout(() => setIsComposing(false), 0);
    };

    // Get permission mode status indicator (CLI-style)
    const getPermissionModeIndicator = (mode: PermissionMode): string => {
      switch (mode) {
        case "default":
          return "🔧 normal mode";
        case "plan":
          return "⏸ plan mode";
        case "acceptEdits":
          return "⏵⏵ accept edits";
        case "bypassPermissions":
          return "⚡ bypass permissions";
      }
    };

    // Get clean permission mode name (without emoji)
    const getPermissionModeName = (mode: PermissionMode): string => {
      switch (mode) {
        case "default":
          return "normal mode";
        case "plan":
          return "plan mode";
        case "acceptEdits":
          return "accept edits";
        case "bypassPermissions":
          return "bypass permissions";
      }
    };

    // Get next permission mode for cycling
    const getNextPermissionMode = (current: PermissionMode): PermissionMode => {
      const modes: PermissionMode[] = [
        "default",
        "plan",
        "acceptEdits",
        "bypassPermissions",
      ];
      const currentIndex = modes.indexOf(current);
      return modes[(currentIndex + 1) % modes.length];
    };

    // If we're in plan permission mode, show the plan permission panel instead
    if (showPermissions && planPermissionData) {
      return (
        <PlanPermissionInputPanel
          onAcceptWithEdits={planPermissionData.onAcceptWithEdits}
          onAcceptDefault={planPermissionData.onAcceptDefault}
          onKeepPlanning={planPermissionData.onKeepPlanning}
          getButtonClassName={planPermissionData.getButtonClassName}
          onSelectionChange={planPermissionData.onSelectionChange}
          externalSelectedOption={planPermissionData.externalSelectedOption}
        />
      );
    }

    // If we're in regular permission mode, show the permission panel instead
    if (showPermissions && permissionData) {
      return (
        <PermissionInputPanel
          patterns={permissionData.patterns}
          onAllow={permissionData.onAllow}
          onAllowPermanent={permissionData.onAllowPermanent}
          onDeny={permissionData.onDeny}
          getButtonClassName={permissionData.getButtonClassName}
          onSelectionChange={permissionData.onSelectionChange}
          externalSelectedOption={permissionData.externalSelectedOption}
        />
      );
    }

    return (
      <div className="flex-shrink-0">
        {/* Image thumbnail strip */}
        {pendingImages && pendingImages.length > 0 && (
          <div className="flex gap-2 px-2 py-2 mb-1 overflow-x-auto">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative flex-shrink-0 group">
                {img.file.type.startsWith("image/") ? (
                  <img
                    src={img.preview}
                    alt={img.file.name}
                    className="w-16 h-16 object-cover rounded-lg border border-slate-300 dark:border-slate-600"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-500 dark:text-slate-400 text-[10px] font-mono text-center px-1">
                    {img.file.name.split(".").pop()?.toUpperCase() || "FILE"}
                  </div>
                )}
                {onImageRemove && (
                  <button
                    type="button"
                    onClick={() => onImageRemove(i)}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                )}
                <div className="text-[9px] text-slate-500 dark:text-slate-400 truncate w-16 text-center mt-0.5">
                  {img.file.name}
                </div>
              </div>
            ))}
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          className="relative"
          onClick={(e) => {
            if (e.target === e.currentTarget) inputRef.current?.focus();
          }}
        >
          {mentionDropdown}
          {slashMenu &&
            slashCommands.length > 0 &&
            (() => {
              const filtered = slashCommands.filter((cmd) =>
                cmd.toLowerCase().includes(slashMenu.query.toLowerCase()),
              );
              if (filtered.length === 0) return null;
              return (
                <div
                  className="absolute z-50 bottom-full mb-1 left-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg max-h-48 overflow-y-auto"
                  style={{ minWidth: "200px" }}
                >
                  {filtered.map((cmd, index) => (
                    <button
                      key={cmd}
                      type="button"
                      className={`w-full px-3 py-2 text-left text-sm font-mono ${
                        index === slashSelectedIndex
                          ? "bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200"
                          : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                      }`}
                      onClick={() => {
                        setInput(`/${cmd} `);
                        setSlashMenu(null);
                        inputRef.current?.focus();
                      }}
                      onMouseEnter={() => setSlashSelectedIndex(index)}
                    >
                      /{cmd}
                    </button>
                  ))}
                </div>
              );
            })()}
          {/* Hidden file input for image upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept="*/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && onImageAdd) {
                onImageAdd(Array.from(e.target.files));
              }
              e.target.value = "";
              // Refocus chat input after file dialog closes
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);

              // Check for @-mention trigger
              if (onMentionTrigger && onMentionClose) {
                const cursorPos = e.target.selectionStart;
                const textBeforeCursor = val.slice(0, cursorPos);
                const atIndex = textBeforeCursor.lastIndexOf("@");
                if (
                  atIndex !== -1 &&
                  (atIndex === 0 || /\s/.test(textBeforeCursor[atIndex - 1]))
                ) {
                  const query = textBeforeCursor.slice(atIndex + 1);
                  if (!query.includes(" ") && !query.includes("\n")) {
                    const rect = e.target.getBoundingClientRect();
                    onMentionTrigger(query, rect);
                  } else {
                    onMentionClose();
                  }
                } else {
                  onMentionClose();
                }
              }

              // Check for /slash command trigger — only when "/" is the first character
              if (val.startsWith("/")) {
                const query = val.slice(1);
                if (!query.includes(" ") && !query.includes("\n")) {
                  setSlashMenu({ query });
                  setSlashSelectedIndex(0);
                } else {
                  setSlashMenu(null);
                }
              } else {
                setSlashMenu(null);
              }
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              // Intercept clipboard images (screenshots from the OS snip tool,
              // copied-from-browser images, etc.) so they flow through the
              // same file-upload path as the paperclip button. Without this,
              // the textarea silently drops image clipboard items and the
              // user's screenshot never reaches disk or the backend.
              if (!onImageAdd) return;
              const files: File[] = [];
              for (const item of Array.from(e.clipboardData.items)) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                  const f = item.getAsFile();
                  if (!f) continue;
                  // Browsers sometimes set file.name to "image.png" — fine.
                  // But OS-level screenshot pastes can arrive nameless, which
                  // would save as "{timestamp}-" with no extension and break
                  // the image-content path. Rename based on the MIME subtype.
                  const hasName = f.name && /\.[a-z0-9]+$/i.test(f.name);
                  if (hasName) {
                    files.push(f);
                  } else {
                    const ext = (f.type.split("/")[1] || "png").split(";")[0];
                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    files.push(
                      new File([f], `pasted-${ts}.${ext}`, { type: f.type }),
                    );
                  }
                }
              }
              if (files.length > 0) {
                e.preventDefault();
                onImageAdd(files);
              }
            }}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder={
              isLoading
                ? "Queue a message, /btw, or /stop..."
                : "Type message..."
            }
            rows={1}
            className={`w-full pl-3 pr-16 py-1.5 bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 backdrop-blur-sm shadow-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 resize-none overflow-hidden min-h-[36px] max-h-[${UI_CONSTANTS.TEXTAREA_MAX_HEIGHT}px] leading-tight`}
            disabled={false}
          />
          {/* Button row vertically centered within the textarea. */}
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-2">
            {onImageAdd && !isLoading && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg transition-colors"
                title="Attach file"
              >
                <PaperClipIcon className="w-4 h-4" />
              </button>
            )}
            {isLoading && (
              <button
                type="button"
                onClick={onAbort}
                className="px-2 py-1 bg-red-100 hover:bg-red-200 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg transition-all duration-200 shadow-sm hover:shadow-md flex items-center gap-1 text-xs font-medium max-h-[28px]"
                title="Stop (ESC)"
              >
                <StopIcon className="w-3.5 h-3.5" />
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={
                !input.trim() && !(pendingImages && pendingImages.length > 0)
              }
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white rounded-lg font-medium transition-all duration-200 shadow-sm hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 text-sm leading-tight max-h-[28px] flex items-center"
            >
              {permissionMode === "plan" ? "Plan" : "Send"}
            </button>
          </div>
        </form>

        {/* Status bar */}
        <div className="flex items-center justify-between px-4 py-1">
          <button
            type="button"
            onClick={() =>
              onPermissionModeChange(getNextPermissionMode(permissionMode))
            }
            className="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 font-mono text-left transition-colors cursor-pointer"
            title={`Current: ${getPermissionModeName(permissionMode)} - Click to cycle (Ctrl+Shift+M)`}
          >
            {getPermissionModeIndicator(permissionMode)}
            <span className="ml-2 text-slate-400 dark:text-slate-500 text-[10px]">
              (Ctrl+Shift+M)
            </span>
          </button>
          <div className="flex items-center gap-3">
            {onThinkingLevelChange && (
              <button
                type="button"
                onClick={() => {
                  const levels: Array<"off" | "brief" | "extended" | "auto"> = [
                    "auto",
                    "off",
                    "brief",
                    "extended",
                  ];
                  const next =
                    levels[(levels.indexOf(thinkingLevel) + 1) % levels.length];
                  onThinkingLevelChange(next);
                }}
                className="text-[10px] font-mono text-purple-500 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 transition-colors cursor-pointer"
                title="Click to cycle thinking level. 'auto' defers to the VM's ~/.claude/settings.json baseline."
              >
                {thinkingLevel === "off"
                  ? "thinking off"
                  : thinkingLevel === "brief"
                    ? "thinking brief (5k)"
                    : thinkingLevel === "extended"
                      ? "thinking extended (32k)"
                      : "thinking auto (settings.json)"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);
