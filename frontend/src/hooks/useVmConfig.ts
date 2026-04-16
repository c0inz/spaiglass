import { useState, useEffect } from "react";

export interface VmConfig {
  role: string;
  vmName: string;
  ipv4?: string | null;
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
          if (!(window as Window & { __SG_BASE?: string }).__SG_BASE) {
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
