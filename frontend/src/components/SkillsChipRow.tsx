/**
 * SkillsChipRow — small horizontal strip of pinned plugin-skill chips
 * that sits just above the ChatInput. Click a chip to insert its slash
 * command into the input. The trailing "+" opens SkillsPickerModal where
 * the user manages pins.
 *
 * Pins persist per-browser via usePinnedSkills (localStorage). The skill
 * catalog comes from useSkills (per-VM HTTP fetch on mount). Pinned-but-
 * uninstalled skills are silently filtered out — no broken chips.
 */

import { useMemo, useState } from "react";
import {
  PlusIcon,
  XMarkIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import { useSkills, type SkillInfo } from "../hooks/useSkills";
import { usePinnedSkills } from "../hooks/usePinnedSkills";
import { SkillsPickerModal } from "./SkillsPickerModal";

interface SkillsChipRowProps {
  /**
   * Called when the user clicks a chip. Receives the slash command (e.g.
   * "/superpowers:brainstorming "). The host inserts it into ChatInput
   * via its imperative ref — that's the same path /btw uses.
   */
  onInvoke: (slashCommand: string) => void;
}

export function SkillsChipRow({ onInvoke }: SkillsChipRowProps) {
  const { skills, loading, error } = useSkills();
  const { pinnedIds, isPinned, toggle, unpin } = usePinnedSkills();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Resolve pinned IDs against the live catalog. Pinned-but-missing
  // (plugin uninstalled, skill renamed) → silently dropped.
  const pinnedSkills: SkillInfo[] = useMemo(() => {
    const map = new Map(skills.map((s) => [s.id, s]));
    return pinnedIds.map((id) => map.get(id)).filter((s): s is SkillInfo => !!s);
  }, [skills, pinnedIds]);

  // Hide the row entirely on hosts with no installed skills — there's
  // nothing to pin and the "+" button would just open an empty modal.
  if (!loading && !error && skills.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-1.5 px-1 pb-1.5 overflow-x-auto">
        <SparklesIcon
          className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 dark:text-slate-500"
          aria-hidden="true"
        />
        {pinnedSkills.length === 0 && !loading && (
          <span className="text-[11px] text-slate-400 dark:text-slate-500 italic">
            pin skills →
          </span>
        )}
        {pinnedSkills.map((s) => (
          <span
            key={s.id}
            className="group inline-flex items-center rounded-full border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors"
          >
            <button
              type="button"
              onClick={() => onInvoke(`${s.slashCommand} `)}
              title={s.description || s.slashCommand}
              className="px-2.5 py-0.5 text-[11px] font-mono"
            >
              {s.name}
            </button>
            <button
              type="button"
              onClick={() => unpin(s.id)}
              title="Unpin"
              aria-label={`Unpin ${s.name}`}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity pr-1.5 pl-0.5 text-purple-400 hover:text-purple-700 dark:hover:text-purple-200"
            >
              <XMarkIcon className="w-3 h-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          title="Manage pinned skills"
          aria-label="Manage pinned skills"
          className="inline-flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-dashed border-slate-300 dark:border-slate-600 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:border-slate-500 transition-colors"
        >
          <PlusIcon className="w-3 h-3" />
        </button>
      </div>
      <SkillsPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        skills={skills}
        loading={loading}
        error={error}
        isPinned={isPinned}
        toggle={toggle}
      />
    </>
  );
}
