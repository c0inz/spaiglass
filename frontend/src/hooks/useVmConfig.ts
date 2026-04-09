import { useState, useEffect } from "react";

interface VmConfig {
  role: string;
  vmName: string;
}

export function useVmConfig() {
  const [config, setConfig] = useState<VmConfig | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setConfig(data);
          // Don't overwrite relay-set title (contains compact project:role name)
          if (!(window as any).__SG_BASE) {
            document.title = `SpAIglass — ${data.role}`;
          }
        }
      })
      .catch(() => {
        // Config endpoint unavailable, use defaults
      });
  }, []);

  return config;
}
