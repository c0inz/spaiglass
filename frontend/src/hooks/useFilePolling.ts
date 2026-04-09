import { useState, useEffect, useRef, useCallback, useMemo } from "react";

interface FileSnapshot {
  files: Record<string, number>;
}

interface UseFilePollingOptions {
  projectPath: string | undefined;
  intervalMs?: number;
  onFilesChanged?: (changed: string[], added: string[], deleted: string[]) => void;
}

export function useFilePolling({
  projectPath,
  intervalMs = 3000,
  onFilesChanged,
}: UseFilePollingOptions) {
  const snapshotRef = useRef<FileSnapshot | null>(null);
  const [externallyModified, setExternallyModified] = useState<string | null>(
    null,
  );

  const dismissExternalChange = useCallback(() => {
    setExternallyModified(null);
  }, []);

  const onFilesChangedRef = useRef(onFilesChanged);
  onFilesChangedRef.current = onFilesChanged;

  useEffect(() => {
    if (!projectPath) return;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/files/snapshot?path=${encodeURIComponent(projectPath)}`,
        );
        if (!res.ok) return;
        const newSnap: FileSnapshot = await res.json();
        const oldSnap = snapshotRef.current;

        if (!oldSnap) {
          snapshotRef.current = newSnap;
          return;
        }

        const changed: string[] = [];
        const added: string[] = [];
        const deleted: string[] = [];

        const allKeys = new Set([
          ...Object.keys(oldSnap.files),
          ...Object.keys(newSnap.files),
        ]);

        for (const key of allKeys) {
          if (!(key in oldSnap.files)) {
            added.push(key);
          } else if (!(key in newSnap.files)) {
            deleted.push(key);
          } else if (oldSnap.files[key] !== newSnap.files[key]) {
            changed.push(key);
          }
        }

        if (changed.length > 0 || added.length > 0 || deleted.length > 0) {
          snapshotRef.current = newSnap;
          onFilesChangedRef.current?.(changed, added, deleted);
        }
      } catch {
        // Polling error — skip
      }
    };

    // Initial snapshot
    poll();

    const interval = setInterval(poll, intervalMs);
    return () => clearInterval(interval);
  }, [projectPath, intervalMs]);

  return { externallyModified, dismissExternalChange, setExternallyModified };
}
