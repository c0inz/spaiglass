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
          document.title = `Spyglass — ${data.role}`;
        }
      })
      .catch(() => {
        // Config endpoint unavailable, use defaults
      });
  }, []);

  return config;
}
