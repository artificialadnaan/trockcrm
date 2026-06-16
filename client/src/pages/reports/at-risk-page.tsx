import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAtRiskWatchlist } from "@/hooks/use-reports";
import { PipelineStageTable, type PipelineStageTableColumn } from "@/components/pipeline/pipeline-stage-table";
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
import { usd, int, formatDayShort } from "./evidence-kit";
import type { AtRiskRecord } from "./part4-types";

// A·3 At-Risk & Value-at-Stake Watchlist -- the forecast's blind spots: open deals with no maintained
// close date or an already-past one (exactly the M − N from the Forecast Confidence Board), ranked by $
// at risk. The rows ARE the evidence (the summary equals the list); click a row to open the deal.

const REASON_BADGE: Record<AtRiskRecord["reason"], { label: string; cls: string }> = {
  stale_dated: { label: "Past due", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  no_date: { label: "No close date", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
};

// Explicit reason ranking so the "Why at-risk" column GROUPS by category (all Past due, then all
// No close date) — deliberate grouping, not incidental alphabetical on the badge label spelling.
const REASON_ORDER: Record<AtRiskRecord["reason"], number> = { stale_dated: 0, no_date: 1 };

const AT_RISK_SORT_COLUMNS: ReadonlyArray<SortColumn<AtRiskRecord>> = [
  { key: "deal", type: "text", accessor: (r) => r.name },
  { key: "owner", type: "text", accessor: (r) => r.repName },
  { key: "stage", type: "text", accessor: (r) => r.stageLabel },
  { key: "days", type: "number", accessor: (r) => r.daysInStage },
  { key: "reason", type: "text", accessor: (r) => r.reason, compare: (a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] },
  { key: "value", type: "number", accessor: (r) => r.value },
];

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

  // initialSort null preserves the server's $-at-risk-desc order until the user clicks a header.
  const { sortedRows, toggle, getHeaderProps } = useTableSort(records, AT_RISK_SORT_COLUMNS);

  const sortHeader = (key: string, label: string, numeric = false) => {
    const hp = getHeaderProps(key);
    return (
      <SortHeaderButton
        label={label}
        numeric={numeric}
        active={hp.active}
        dir={hp.dir}
        onClick={() => toggle(key)}
        className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500"
      />
    );
  };

  const columns: Array<PipelineStageTableColumn<AtRiskRecord>> = [
    {
      key: "deal",
      header: sortHeader("deal", "Deal"),
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-800">{r.name}</div>
          {r.dealNumber ? <div className="text-xs text-slate-400">#{r.dealNumber}</div> : null}
        </div>
      ),
    },
    { key: "owner", header: sortHeader("owner", "Owner"), render: (r) => <span className="text-slate-600">{r.repName}</span> },
    { key: "stage", header: sortHeader("stage", "Stage"), render: (r) => <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{r.stageLabel || "—"}</span> },
    { key: "days", header: sortHeader("days", "In stage", true), cellClassName: "whitespace-nowrap tabular-nums text-slate-500", render: (r) => (r.daysInStage == null ? "—" : `${int(r.daysInStage)}d`) },
    {
      key: "reason",
      header: sortHeader("reason", "Why at-risk"),
      render: (r) => {
        const b = REASON_BADGE[r.reason];
        const close = r.reason === "stale_dated" && r.expectedCloseDate ? ` · ${formatDayShort(r.expectedCloseDate)}` : "";
        return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${b.cls}`}>{b.label}{close}</span>;
      },
    },
    { key: "value", header: sortHeader("value", "$ at risk", true), headClassName: "text-right", cellClassName: "text-right font-semibold tabular-nums text-slate-800", render: (r) => usd(r.value) },
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
              rows={sortedRows}
              columns={columns}
              pagination={{ page: 1, pageSize: sortedRows.length, total: sortedRows.length, totalPages: 1 }}
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
