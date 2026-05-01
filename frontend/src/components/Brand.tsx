/**
 * SpaiGlass wordmark — the canonical brand text.
 *
 * Always render the product name through this component (header, landing,
 * marketing copy, modals, etc). Standardizes:
 *   - capitalization: "SpaiGlass"
 *   - color treatment: gold "ai" infix; surrounding "Sp" + "Glass" inherit
 *     the parent's text color, so they're white on dark / black on light
 *     when wrapped in the standard `text-slate-800 dark:text-slate-100`
 *     header pattern.
 *
 * For plain-text contexts where styling can't apply (window.title, alert
 * strings), use the literal "SpaiGlass" string instead of this component.
 */
export function Brand({ className = "" }: { className?: string }) {
  return (
    <span className={className}>
      Sp<span className="text-amber-500 dark:text-amber-400">ai</span>Glass
    </span>
  );
}
