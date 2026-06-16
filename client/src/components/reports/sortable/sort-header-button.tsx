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
  const sortAttr = !active ? "none" : dir === "asc" ? "ascending" : "descending";
  const labelText = typeof label === "string" ? label : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      data-sort={sortAttr}
      aria-label={labelText ? `Sort by ${labelText}` : "Sort column"}
      title={labelText ? `Sort by ${labelText}` : "Sort"}
      className={cn(
        "inline-flex items-center gap-1 transition hover:text-slate-800",
        numeric ? "flex-row-reverse" : "",
        className,
      )}
    >
      {label}
      {!active ? (
        <ChevronsUpDown className="h-3 w-3 text-slate-300" aria-hidden="true" />
      ) : dir === "asc" ? (
        <ArrowUp className="h-3 w-3 text-slate-600" aria-hidden="true" />
      ) : (
        <ArrowDown className="h-3 w-3 text-slate-600" aria-hidden="true" />
      )}
    </button>
  );
}
