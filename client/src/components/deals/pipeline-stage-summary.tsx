import { cn } from "@/lib/utils";
import { formatCurrencyCompact } from "@/lib/deal-utils";

export interface PipelineStageSummaryColumn {
  stage: { id: string; name: string };
  count: number;
  totalValue: number;
}

/**
 * Mobile-only (`md:hidden`) compact view of the pipeline board. A multi-column drag board is the
 * classic phone problem (horizontal scroll wall, drag-across-stages is unusable), and the board's
 * real value on a phone is the at-a-glance breakdown, not the drag interaction — so on phones we
 * render one tappable chip per stage (name + deal count + total value) and let the already-responsive
 * deals list below be the primary working surface. The full drag-and-drop board stays mounted as
 * `hidden md:flex`, so desktop (>=md) is byte-identical.
 *
 * Each chip reuses the exact figures the desktop column header shows (count, formatCurrencyCompact),
 * so the summary can never drift from the board. Tapping a chip filters the list below to that stage:
 * the page writes the FilterBar's URL-backed `stageIds` param (the bar re-derives from the URL), so
 * this stays lane-safe — no FilterBar component is touched.
 */
export function PipelineStageSummary({
  columns,
  activeStageId,
  onSelectStage,
}: {
  columns: PipelineStageSummaryColumn[];
  /** The stage whose filter is currently the sole active list filter (highlighted), or null. */
  activeStageId: string | null;
  /** Toggle the list's stage filter to this stage (the page owns the URL write). */
  onSelectStage: (stageId: string) => void;
}) {
  if (columns.length === 0) return null;

  return (
    <section className="space-y-2 md:hidden" aria-label="Pipeline by stage">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Pipeline by stage
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {columns.map((column) => {
          const isActive = activeStageId === column.stage.id;
          return (
            <button
              key={column.stage.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelectStage(column.stage.id)}
              className={cn(
                "flex min-h-[44px] flex-col gap-1 rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
                isActive
                  ? "border-brand-red bg-brand-red/5"
                  : "border-gray-200 bg-white hover:border-gray-300"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium uppercase tracking-wide text-gray-500">
                  {column.stage.name}
                </span>
                <span className="rounded-sm bg-gray-200/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-gray-600">
                  {column.count}
                </span>
              </div>
              <span className="text-lg font-semibold tabular-nums text-gray-900">
                {formatCurrencyCompact(column.totalValue)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
