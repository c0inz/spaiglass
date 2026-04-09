interface StaleContextBannerProps {
  staleFiles: string[];
  onReRead: (filePath: string) => void;
  onDismiss: () => void;
}

export function StaleContextBanner({
  staleFiles,
  onReRead,
  onDismiss,
}: StaleContextBannerProps) {
  if (staleFiles.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800/30 text-xs">
      <span className="text-yellow-600 dark:text-yellow-400 font-medium flex-shrink-0">
        Stale context:
      </span>
      <div className="flex-1 flex flex-wrap gap-1">
        {staleFiles.map((f) => {
          const name = f.split("/").pop() || f;
          return (
            <button
              key={f}
              onClick={() => onReRead(f)}
              className="text-yellow-700 dark:text-yellow-300 hover:text-yellow-900 dark:hover:text-yellow-100 underline"
              title={`${f} changed since Claude last read it. Click to re-read.`}
            >
              {name}
            </button>
          );
        })}
      </div>
      <button
        onClick={onDismiss}
        className="text-yellow-500 hover:text-yellow-700 dark:hover:text-yellow-300 flex-shrink-0"
      >
        ✕
      </button>
    </div>
  );
}
