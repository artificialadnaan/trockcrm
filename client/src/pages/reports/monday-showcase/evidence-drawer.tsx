import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  PipelineStageTable,
  type PipelineStageTableColumn,
} from "@/components/pipeline/pipeline-stage-table";
import { useShowcaseEvidence } from "@/hooks/use-reports";
import type { EvidenceRecord, EvidenceRequest, MondayShowcaseEvidence } from "./types";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = (n: number) => n.toLocaleString("en-US");

// Literal-day formatting (no UTC-midnight off-by-one), matching the app's date-only rendering (#572).
function formatCohortDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function evidenceColumns(ev: MondayShowcaseEvidence): Array<PipelineStageTableColumn<EvidenceRecord>> {
  const hasValue = ev.metric !== "leads";
  const columns: Array<PipelineStageTableColumn<EvidenceRecord>> = [
    {
      key: "deal",
      header: ev.metric === "leads" ? "Lead" : "Deal",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-800">{r.name}</div>
          {r.dealNumber ? <div className="text-xs text-slate-400">#{r.dealNumber}</div> : null}
        </div>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      render: (r) => <span className="text-slate-600">{r.repName}</span>,
    },
    {
      key: "stage",
      header: "Stage",
      render: (r) => (
        <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
          {r.stageLabel || "—"}
        </span>
      ),
    },
    {
      key: "date",
      header: ev.dateAxisLabel,
      cellClassName: "whitespace-nowrap text-slate-600",
      render: (r) => formatCohortDate(r.cohortDate),
    },
  ];
  if (hasValue) {
    columns.push({
      key: "value",
      header: "Value",
      headClassName: "text-right",
      cellClassName: "text-right font-semibold tabular-nums text-slate-800",
      render: (r) => (r.value == null ? "—" : usd(r.value)),
    });
  }
  return columns;
}

function ReconciliationBanner({ ev }: { ev: MondayShowcaseEvidence }) {
  const { total } = ev;
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
      <span className="font-semibold">{int(total.count)}</span>{" "}
      {total.count === 1 ? "record" : "records"}
      {total.value != null && (
        <>
          {" · "}
          <span className="font-semibold">{usd(total.value)}</span>
        </>
      )}
      {total.basisLabel && <span className="text-emerald-700"> · {total.basisLabel}</span>}
      <div className="mt-0.5 text-xs text-emerald-700">
        These are the exact records behind the number — they reconcile to it by construction.
      </div>
    </div>
  );
}

export function EvidenceDrawer({
  request,
  mode,
  onClose,
}: {
  request: EvidenceRequest | null;
  mode: "to_date" | "completed";
  onClose: () => void;
}) {
  const { data, loading, error } = useShowcaseEvidence(request, mode);

  return (
    <Sheet
      open={request != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
        <SheetHeader className="border-b border-slate-100 pb-3">
          <SheetTitle>{request?.title ?? "Supporting records"}</SheetTitle>
          <SheetDescription>
            {request?.subtitle ? `${request.subtitle} · ` : ""}
            {data ? data.period.label : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-8">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
          ) : data ? (
            data.records.length === 0 ? (
              <div className="space-y-3">
                <ReconciliationBanner ev={data} />
                <div className="rounded-lg border bg-slate-50 p-6 text-center text-sm text-muted-foreground">
                  No supporting records for this number in this period.
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <ReconciliationBanner ev={data} />
                <PipelineStageTable
                  rows={data.records}
                  columns={evidenceColumns(data)}
                  pagination={{ page: 1, pageSize: data.records.length, total: data.records.length, totalPages: 1 }}
                  onPageChange={() => {}}
                  getRowKey={(r) => r.id}
                  showPagination={false}
                />
                <p className="px-1 text-xs text-muted-foreground">
                  Shown on the {data.dateAxisLabel.toLowerCase()} axis — the cohort this number is defined on.
                </p>
              </div>
            )
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
