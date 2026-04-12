import {
  ChatBubbleLeftRightIcon,
  FolderIcon,
  DocumentTextIcon,
  Squares2X2Icon,
  ClockIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";

export type MobileTab = "chat" | "files" | "editor" | "arch" | "history" | "secrets";

interface MobileTabBarProps {
  activeTab: MobileTab;
  editorEnabled: boolean;
  onSelect: (tab: MobileTab) => void;
}

interface TabDef {
  id: MobileTab;
  label: string;
  Icon: typeof ChatBubbleLeftRightIcon;
}

const TABS: TabDef[] = [
  { id: "chat", label: "Chat", Icon: ChatBubbleLeftRightIcon },
  { id: "files", label: "Files", Icon: FolderIcon },
  { id: "editor", label: "Editor", Icon: DocumentTextIcon },
  { id: "arch", label: "Arch", Icon: Squares2X2Icon },
  { id: "secrets", label: "Secrets", Icon: KeyIcon },
  { id: "history", label: "History", Icon: ClockIcon },
];

/**
 * Bottom tab bar for the mobile (≤767px) layout. Five mutually-exclusive
 * destinations: Chat, Files, Editor, Arch, History. The Editor tab is
 * disabled until the user opens a file from the Files tab — same lifecycle
 * as the desktop middle panel.
 *
 * Settings is intentionally not a tab — it stays on the gear icon in the
 * compact header so the four working surfaces own the bottom bar.
 */
export function MobileTabBar({
  activeTab,
  editorEnabled,
  onSelect,
}: MobileTabBarProps) {
  return (
    <nav
      className="flex-shrink-0 flex items-stretch border-t border-slate-200 dark:border-slate-700 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md"
      aria-label="Main sections"
    >
      {TABS.map(({ id, label, Icon }) => {
        const isActive = activeTab === id;
        const isDisabled = id === "editor" && !editorEnabled;
        return (
          <button
            key={id}
            type="button"
            disabled={isDisabled}
            onClick={() => onSelect(id)}
            aria-current={isActive ? "page" : undefined}
            aria-label={label}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
              isActive
                ? "text-blue-600 dark:text-blue-400"
                : isDisabled
                  ? "text-slate-300 dark:text-slate-600 cursor-not-allowed"
                  : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            <Icon className="w-5 h-5" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
