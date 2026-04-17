import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { RolesSettings } from "./settings/RolesSettings";
import { GeneralSettings } from "./settings/GeneralSettings";
import { ThemeSettings } from "./settings/ThemeSettings";

type SettingsTab = "roles" | "settings" | "theme";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "roles", label: "Roles" },
  { id: "settings", label: "Settings" },
  { id: "theme", label: "Theme" },
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectPath?: string;
  onRoleCreated?: () => void;
}

export function SettingsModal({ isOpen, onClose, projectPath, onRoleCreated }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("roles");

  useEffect(() => {
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscKey);
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.removeEventListener("keydown", handleEscKey);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={handleBackdropClick}
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-0">
          <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            aria-label="Close settings"
          >
            <XMarkIcon className="w-5 h-5 text-slate-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 px-6 mt-3">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === tab.id
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1">
          <div className="p-6">
            {activeTab === "roles" && (
              <RolesSettings projectPath={projectPath} onRoleCreated={onRoleCreated} />
            )}
            {activeTab === "settings" && <GeneralSettings projectPath={projectPath} />}
            {activeTab === "theme" && <ThemeSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
