import { useEffect, useRef, useState } from "react";
import { Brand } from "./Brand";

/**
 * Top-left help popover.
 *
 * SpAIglass is a browser UI for Claude Code — it does not launch Claude
 * itself. Structural changes (add/remove servers, add/remove project
 * directories, rename things) are done by asking the VM-side install
 * agent, which knows the APIs documented at /setup. The Settings wheel
 * (top-right) still handles cosmetic display overrides.
 */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Help"
        title="Help"
        className="w-7 h-7 flex items-center justify-center rounded-full border border-slate-300 dark:border-slate-600 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-100 text-sm font-semibold transition-colors"
      >
        ?
      </button>
      {open && (
        <div
          role="dialog"
          className="help-popover absolute left-0 top-full mt-2 w-[340px] z-50 rounded-lg border border-slate-200 dark:border-slate-700 shadow-xl p-3 text-sm text-slate-700 dark:text-slate-200 leading-relaxed"
        >
          Ask your agent that installed <Brand /> how to modify server and
          directory picklist items or resolve issues if they are not working
          correctly. <Brand />, like Telegram, does not start Claude for you.
          You can make some changes to what is displayed on your screen, browser
          tab and last used buttons by changing settings using the Settings
          wheel button on the top right.
        </div>
      )}
    </div>
  );
}
