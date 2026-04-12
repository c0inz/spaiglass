import { CogIcon } from "@heroicons/react/24/outline";

interface SettingsButtonProps {
  onClick: () => void;
}

export function SettingsButton({ onClick }: SettingsButtonProps) {
  return (
    <button
      onClick={onClick}
      className="p-2 rounded-lg border transition-all duration-200 bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800"
      aria-label="Open settings"
    >
      <CogIcon className="w-5 h-5 text-slate-600 dark:text-slate-400" />
    </button>
  );
}
