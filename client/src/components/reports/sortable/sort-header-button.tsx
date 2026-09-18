import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortDirection } from "./comparators";

export interface SortHeaderButtonProps {
  label: ReactNode;
  active: boolean;
  dir: SortDirection | null;
  numeric?: boolean;
  onClick: () => void;
  className?: string;
}

// Container-agnostic: drop inside a <th>, a PipelineStageTable column `header`, or a grid <div>.
// `className` is passthrough so each report keeps its own header typography; this adds only the
// click + 3-state caret affordance.
export function SortHeaderButton({ label, active, dir, numeric, onClick, className }: SortHeaderButtonProps) {
  // Only treat the column as sorted when a real direction is present. active + dir=null is not
  // reachable through the hook (getHeaderProps couples them), but the prop type permits it, so guard
  // against announcing a false "descending" if a caller ever passes the inconsistent combo.
  const hasDir = active && (dir === "asc" || dir === "desc");
  const sortAttr = !hasDir ? "none" : dir === "asc" ? "ascending" : "descending";
  const labelText = typeof label === "string" ? label : undefined;
  // Communicate the active sort state through the accessible name so screen-reader users hear it
  // ("Sort by Value, sorted descending"). aria-sort itself belongs on the host <th>, which this
  // container-agnostic button can't own (it also renders inside grid <div>s), so the direction is
  // carried in the name instead.
  const accessibleName = labelText
    ? hasDir
      ? `Sort by ${labelText}, sorted ${dir === "asc" ? "ascending" : "descending"}`
      : `Sort by ${labelText}`
    : "Sort column";
  return (
    <button
      type="button"
      onClick={onClick}
      data-sort={sortAttr}
      aria-label={accessibleName}
      title={accessibleName}
      className={cn(
        // `min-h-6` is the WCAG 2.2 SC 2.5.8 minimum target (24px), not a style choice. Without it the
        // button is exactly as tall as its own text — 16px on every sortable table in the app — and none
        // of the exceptions apply: this is a standalone control in a header cell, not a link inside a
        // sentence, and the same sort is not offered anywhere larger on the page.
        "inline-flex min-h-6 items-center gap-1 transition hover:text-slate-800",
        numeric ? "flex-row-reverse" : "",
        className,
      )}
    >
      {label}
      {!hasDir ? (
        <ChevronsUpDown className="h-3 w-3 text-slate-300" aria-hidden="true" />
      ) : dir === "asc" ? (
        <ArrowUp className="h-3 w-3 text-slate-600" aria-hidden="true" />
      ) : (
        <ArrowDown className="h-3 w-3 text-slate-600" aria-hidden="true" />
      )}
    </button>
  );
}
