import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAtRiskWatchlist } from "@/hooks/use-reports";
import { PipelineStageTable, type PipelineStageTableColumn } from "@/components/pipeline/pipeline-stage-table";
import { usd, int, formatDayShort } from "./evidence-kit";
import type { AtRiskRecord } from "./part4-types";

// A·3 At-Risk & Value-at-Stake Watchlist -- the forecast's blind spots: open deals with no maintained
// close date or an already-past one (exactly the M − N from the Forecast Confidence Board), ranked by $
// at risk. The rows ARE the evidence (the summary equals the list); click a row to open the deal.

const REASON_BADGE: Record<AtRiskRecord["reason"], { label: string; cls: string }> = {
  stale_dated: { label: "Past due", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  no_date: { label: "No close date", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
};

function SummaryCard({ label, count, value, tone }: { label: string; count: number; value: number; tone: string }) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4`}>
      <span className={`absolute inset-y-0 left-0 w-1 ${tone}`} />
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-extrabold tabular-nums text-slate-800">{usd(value)}</div>
      <div className="text-xs tabular-nums text-slate-400">{int(count)} {count === 1 ? "deal" : "deals"}</div>
    </div>
  );
}

export function AtRiskPage() {
  const { data, loading, error } = useAtRiskWatchlist();
  const [repFilter, setRepFilter] = useState<string>("__all__");
  const navigate = useNavigate();
  const { search } = useLocation(); // preserve ?officeId when opening a deal from the watchlist

  const repOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, string>();
    for (const r of data.records) seen.set(r.repId ?? "__unassigned__", r.repName);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const records = useMemo(() => {
    if (!data) return [];
    if (repFilter === "__all__") return data.records;
    return data.records.filter((r) => (r.repId ?? "__unassigned__") === repFilter);
  }, [data, repFilter]);

  const filtered = useMemo(() => {
    // Unfiltered: use the canonical server aggregates verbatim. Filtered to one rep: recompute from the
    // shown records (the server fetch is office-wide; the recompute still reconciles to the visible list).
    if (data && repFilter === "__all__") {
      return {
        total: { count: data.summary.count, value: data.summary.valueAtRisk },
        stale: { count: data.byReason.stale_dated.count, value: data.byReason.stale_dated.valueAtRisk },
        undated: { count: data.byReason.no_date.count, value: data.byReason.no_date.valueAtRisk },
      };
    }
    const sum = (rs: AtRiskRecord[]) => rs.reduce((s, r) => s + r.value, 0);
    const stale = records.filter((r) => r.reason === "stale_dated");
    const undated = records.filter((r) => r.reason === "no_date");
    return {
      total: { count: records.length, value: sum(records) },
      stale: { count: stale.length, value: sum(stale) },
      undated: { count: undated.length, value: sum(undated) },
    };
  }, [data, records, repFilter]);

  const columns: Array<PipelineStageTableColumn<AtRiskRecord>> = [
    {
      key: "deal",
      header: "Deal",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-800">{r.name}</div>
          {r.dealNumber ? <div className="text-xs text-slate-400">#{r.dealNumber}</div> : null}
        </div>
      ),
    },
    { key: "owner", header: "Owner", render: (r) => <span className="text-slate-600">{r.repName}</span> },
    { key: "stage", header: "Stage", render: (r) => <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{r.stageLabel || "—"}</span> },
    { key: "days", header: "In stage", cellClassName: "whitespace-nowrap tabular-nums text-slate-500", render: (r) => (r.daysInStage == null ? "—" : `${int(r.daysInStage)}d`) },
    {
      key: "reason",
      header: "Why at-risk",
      render: (r) => {
        const b = REASON_BADGE[r.reason];
        const close = r.reason === "stale_dated" && r.expectedCloseDate ? ` · ${formatDayShort(r.expectedCloseDate)}` : "";
        return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${b.cls}`}>{b.label}{close}</span>;
      },
    },
    { key: "value", header: "$ at risk", headClassName: "text-right", cellClassName: "text-right font-semibold tabular-nums text-slate-800", render: (r) => usd(r.value) },
  ];

  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Reports · Intervention</p>
        <h1 className="text-2xl font-bold">At-Risk &amp; Value-at-Stake Watchlist</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Open deals the forecast can't see — no maintained close date, or one already past. These are exactly
          the blind spots behind the Forecast Confidence Board's coverage caption. Click a deal to open it.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Total at risk" count={filtered.total.count} value={filtered.total.value} tone="bg-slate-400" />
            <SummaryCard label="Past due" count={filtered.stale.count} value={filtered.stale.value} tone="bg-rose-500" />
            <SummaryCard label="No close date" count={filtered.undated.count} value={filtered.undated.value} tone="bg-amber-500" />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500">Rep</span>
            <select
              value={repFilter}
              onChange={(e) => setRepFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm"
            >
              <option value="__all__">All reps</option>
              {repOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>

          {records.length === 0 ? (
            <div className="rounded-lg border bg-slate-50 p-6 text-center text-sm text-muted-foreground">
              No at-risk deals{repFilter === "__all__" ? "" : " for this rep"} — every open deal has a maintained close date. 🎯
            </div>
          ) : (
            <PipelineStageTable
              rows={records}
              columns={columns}
              pagination={{ page: 1, pageSize: records.length, total: records.length, totalPages: 1 }}
              onPageChange={() => {}}
              onRowClick={(r) => navigate({ pathname: `/deals/${r.id}`, search })}
              getRowKey={(r) => r.id}
              showPagination={false}
            />
          )}
        </div>
      ) : (
        <div className="rounded-lg border bg-gray-50 p-6 text-sm text-muted-foreground">No watchlist data.</div>
      )}
    </div>
  );
}
