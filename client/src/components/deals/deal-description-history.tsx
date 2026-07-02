import { useState } from "react";
import { History, ChevronDown, ChevronRight, ArrowRight } from "lucide-react";
import { formatDate } from "@/lib/deal-utils";
import { useDealDescriptionHistory } from "@/hooks/use-deal-description-history";

/**
 * A collapsed change-log of how a deal's description has evolved, rendered under the description in the
 * Stage & Status card. Self-hides when there is no logged change (a never-edited description has none), so
 * it only appears once the scope has actually changed at least once.
 */
export function DealDescriptionHistory({ dealId }: { dealId: string }) {
  const { history, loading } = useDealDescriptionHistory(dealId);
  const [open, setOpen] = useState(false);

  if (loading || history.length === 0) return null;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-800"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <History className="h-3.5 w-3.5" />
        Description history ({history.length})
      </button>

      {open && (
        <ol className="mt-2 space-y-2">
          {history.map((entry) => (
            <li
              key={entry.id}
              className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs"
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span className="font-medium text-slate-600">{entry.changedByName ?? "Unknown"}</span>
                <span className="whitespace-nowrap">{formatDate(entry.changedAt)}</span>
              </div>
              <DescriptionDiff oldValue={entry.oldValue} newValue={entry.newValue} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DescriptionDiff({ oldValue, newValue }: { oldValue: string | null; newValue: string | null }) {
  if (oldValue == null) {
    return (
      <p className="whitespace-pre-wrap text-slate-700">
        <span className="mr-1 font-semibold text-emerald-600">Added:</span>
        {newValue}
      </p>
    );
  }
  if (newValue == null) {
    return (
      <p className="whitespace-pre-wrap text-slate-500">
        <span className="mr-1 font-semibold text-rose-600">Cleared:</span>
        <span className="line-through">{oldValue}</span>
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="whitespace-pre-wrap text-slate-400 line-through">{oldValue}</p>
      <p className="flex items-start gap-1 whitespace-pre-wrap text-slate-700">
        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
        <span>{newValue}</span>
      </p>
    </div>
  );
}
