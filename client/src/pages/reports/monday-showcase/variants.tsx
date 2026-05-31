import { useMemo, useState, type ReactNode } from "react";
import {
  PROJECTION_BAND_LABEL,
  type MondayShowcaseData,
  type DepartmentMetric,
  type ProjectionLadder,
  type RepShowcaseRow,
} from "./types";

// Every variant below renders a slice of the SAME payload -- so Won/Sent/Estimated/Projection figures
// are identical across all of them by construction (locked server-side by the reconciliation test).

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = (n: number) => n.toLocaleString("en-US");
const signed = (n: number) => (n > 0 ? `+${int(n)}` : int(n));

function DeltaChip({ delta }: { delta: number | null }) {
  if (delta == null) return null;
  const tone = delta > 0 ? "text-emerald-700 bg-emerald-50" : delta < 0 ? "text-red-700 bg-red-50" : "text-gray-600 bg-gray-100";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>{signed(delta)} WoW</span>;
}

function Sparkline({ values, spikeIndex }: { values: number[]; spikeIndex?: number }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-10 items-end gap-0.5" aria-hidden>
      {values.map((v, i) => (
        <div
          key={i}
          title={spikeIndex === i ? `${v} (backfill spike — excluded from averages)` : String(v)}
          className={`w-2 rounded-t ${spikeIndex === i ? "bg-amber-300" : "bg-sky-400"}`}
          style={{ height: `${Math.max(2, (v / max) * 40)}px` }}
        />
      ))}
    </div>
  );
}

function basisLabel(metric: { value: { basisLabel: string } | null }) {
  return metric.value?.basisLabel ?? "";
}

function CoverageCaption({ ladder }: { ladder: ProjectionLadder }) {
  return <p className="text-xs text-muted-foreground">{ladder.coverageCaption}</p>;
}

function ProjectionRungs({ ladder, compact = false }: { ladder: ProjectionLadder; compact?: boolean }) {
  return (
    <div className={`grid ${compact ? "grid-cols-4 gap-1" : "grid-cols-4 gap-2"}`}>
      {ladder.bands.map((b) => (
        <div key={b.band} className="rounded border bg-white p-2 text-center">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{PROJECTION_BAND_LABEL[b.band]}</div>
          <div className="text-sm font-semibold">{int(b.count)}</div>
          <div className="text-[10px] text-muted-foreground">{usd(b.value)}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------- Report A (weekly per-department) ----------------

export function VariantA1Funnel({ data }: { data: MondayShowcaseData }) {
  const order: Array<DepartmentMetric["key"]> = ["estimating", "sent", "won", "collected"];
  const depts = order.map((k) => data.departments.find((d) => d.key === k)!).filter(Boolean);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-stretch gap-2">
        {depts.map((d, i) => (
          <div key={d.key} className="flex items-center gap-2">
            <div className={`min-w-[150px] rounded-lg border p-3 ${d.deferred ? "border-dashed bg-gray-50 text-gray-400" : "bg-white"}`}>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{d.label}</div>
              <div className="text-2xl font-bold">{d.deferred ? "—" : int(d.count ?? 0)}</div>
              <div className="text-xs text-muted-foreground">{d.deferred ? "deferred" : `${usd(d.value?.amount ?? 0)} · ${basisLabel(d)}`}</div>
            </div>
            {i < depts.length - 1 && (
              <div className="text-center text-xs text-muted-foreground">
                <div className="text-lg">›</div>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Same-week throughput, not a cohort conversion — Estimated/Sent are stage-entry cohorts, Won is a close-date cohort.
      </p>
    </div>
  );
}

export function VariantA2Scoreboard({ data }: { data: MondayShowcaseData }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {data.departments.map((d) => (
        <div key={d.key} className={`rounded-lg border p-3 ${d.deferred ? "border-dashed bg-gray-50" : "bg-white"}`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{d.label}</span>
            <DeltaChip delta={d.deltaCountWoW} />
          </div>
          <div className="mt-1 text-2xl font-bold">{d.deferred ? "—" : int(d.count ?? 0)}</div>
          <div className="text-xs text-muted-foreground">{d.deferred ? "Awaiting finance source" : `${usd(d.value?.amount ?? 0)} · ${basisLabel(d)}`}</div>
          {!d.deferred && d.sparkline.length > 0 && (
            <div className="mt-2">
              <Sparkline values={d.sparkline} spikeIndex={data.weeklyTrend.slice(-8).findIndex((w) => w.spikeExcluded)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function VariantA3Lanes({ data }: { data: MondayShowcaseData }) {
  const lanes: Array<{ key: "estimating" | "sent" | "won"; label: string }> = [
    { key: "estimating", label: "Estimating" },
    { key: "sent", label: "Sent" },
    { key: "won", label: "Won" },
  ];
  const weeks = data.weeklyTrend.slice(-8);
  const lastIdx = weeks.length - 1;
  return (
    <div className="space-y-4">
      {lanes.map((lane) => {
        const series = weeks.map((w) => w[lane.key]);
        const usable = weeks.filter((w) => !w.spikeExcluded).map((w) => w[lane.key]);
        const avg = usable.length ? usable.reduce((s, v) => s + v, 0) / usable.length : 0;
        const current = series[lastIdx] ?? 0;
        const delta = Math.round(current - avg);
        return (
          <div key={lane.key} className="rounded-lg border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">{lane.label}</span>
              <span className="text-xs text-muted-foreground">
                this week {int(current)} · 8wk avg {avg.toFixed(1)} ({signed(delta)})
                <span className="ml-1 italic">· current week in progress</span>
              </span>
            </div>
            <div className="flex h-16 items-end gap-1">
              {series.map((v, i) => {
                const max = Math.max(1, ...series);
                const spike = weeks[i]?.spikeExcluded;
                return (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      title={spike ? `${v} (spike — excluded from avg)` : i === lastIdx ? `${v} (in progress)` : String(v)}
                      className={`w-full rounded-t ${spike ? "bg-amber-300" : i === lastIdx ? "bg-sky-300" : "bg-sky-500"}`}
                      style={{ height: `${Math.max(2, (v / max) * 56)}px` }}
                    />
                    <span className="text-[9px] text-muted-foreground">{weeks[i]?.weekStart.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------- Exec hero (split-out tile) ----------------

export function VariantExecHero({ data }: { data: MondayShowcaseData }) {
  const tiles = [
    { label: "Won", metric: data.execHero.won, accent: "text-emerald-700" },
    { label: "Sent", metric: data.execHero.sent, accent: "text-sky-700" },
    { label: "Estimated", metric: data.execHero.estimated, accent: "text-indigo-700" },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border bg-white p-6 text-center shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t.label} this week</div>
          <div className={`mt-2 text-4xl font-extrabold ${t.accent}`}>{int(t.metric.count)}</div>
          <div className="mt-1 text-sm text-muted-foreground">{usd(t.metric.value.amount)}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{t.metric.value.basisLabel}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------- Report B (per-rep) ----------------

export function VariantB1Scorecards({ data }: { data: MondayShowcaseData }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {data.reps.map((rep) => (
        <div key={rep.repId ?? "unassigned"} className="rounded-lg border bg-white p-3">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">{rep.repName}</span>
            <span className="text-sm">
              <span className="font-bold text-emerald-700">{int(rep.closed.count)}</span> closed · {usd(rep.closed.value.amount)}
            </span>
          </div>
          <div className="mt-2"><ProjectionRungs ladder={rep.projection} compact /></div>
          <CoverageCaption ladder={rep.projection} />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-sky-50 px-2 py-0.5 text-sky-700">Sent {int(rep.sentThisWeek.count)}</span>
            {rep.leadStatus.map((ls) => (
              <span key={ls.stageLabel} className="rounded bg-gray-100 px-2 py-0.5 text-gray-700">
                {ls.stageLabel}: {int(ls.count)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type SortKey = "closed" | "projected" | "sent" | "leads";

function repProjectedTotal(rep: RepShowcaseRow) {
  return rep.projection.bands.reduce((s, b) => s + b.count, 0);
}
function repLeadTotal(rep: RepShowcaseRow) {
  return rep.leadStatus.reduce((s, l) => s + l.count, 0);
}

export function VariantB2Leaderboard({ data }: { data: MondayShowcaseData }) {
  const [sort, setSort] = useState<SortKey>("closed");
  const rows = useMemo(() => {
    const val = (r: RepShowcaseRow) =>
      sort === "closed" ? r.closed.value.amount : sort === "projected" ? repProjectedTotal(r) : sort === "sent" ? r.sentThisWeek.count : repLeadTotal(r);
    return [...data.reps].sort((a, b) => val(b) - val(a));
  }, [data.reps, sort]);
  const totals = {
    closed: data.reps.reduce((s, r) => s + r.closed.value.amount, 0),
    closedCount: data.reps.reduce((s, r) => s + r.closed.count, 0),
    projected: data.reps.reduce((s, r) => s + repProjectedTotal(r), 0),
    sent: data.reps.reduce((s, r) => s + r.sentThisWeek.count, 0),
    leads: data.reps.reduce((s, r) => s + repLeadTotal(r), 0),
  };
  const Th = ({ k, children }: { k: SortKey; children: ReactNode }) => (
    <th
      className={`cursor-pointer px-3 py-2 text-right ${sort === k ? "text-foreground underline" : "text-muted-foreground"}`}
      onClick={() => setSort(k)}
    >
      {children}
    </th>
  );
  return (
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="w-full text-sm">
        <thead className="border-b bg-gray-50 text-xs uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2 text-left">Rep</th>
            <Th k="closed">Closed $</Th>
            <Th k="projected">Projected #</Th>
            <Th k="sent">Sent</Th>
            <Th k="leads">Active leads</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.repId ?? "unassigned"} className="border-b last:border-0">
              <td className="px-3 py-2">{i + 1}. {r.repName}</td>
              <td className="px-3 py-2 text-right font-semibold">{usd(r.closed.value.amount)}</td>
              <td className="px-3 py-2 text-right">{int(repProjectedTotal(r))}</td>
              <td className="px-3 py-2 text-right">{int(r.sentThisWeek.count)}</td>
              <td className="px-3 py-2 text-right">{int(repLeadTotal(r))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t bg-gray-50 font-semibold">
          <tr>
            <td className="px-3 py-2 text-left">TOTAL ({int(totals.closedCount)} won)</td>
            <td className="px-3 py-2 text-right">{usd(totals.closed)}</td>
            <td className="px-3 py-2 text-right">{int(totals.projected)}</td>
            <td className="px-3 py-2 text-right">{int(totals.sent)}</td>
            <td className="px-3 py-2 text-right">{int(totals.leads)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="px-3 py-2 text-xs text-muted-foreground">TOTAL Closed $ ties to the canonical office Won aggregate. Click a column to re-rank.</p>
    </div>
  );
}

export function VariantB3LoadLane({ data }: { data: MondayShowcaseData }) {
  return (
    <div className="space-y-3">
      {data.reps.map((rep) => (
        <div key={rep.repId ?? "unassigned"} className="rounded-lg border bg-white p-3">
          <div className="mb-2 font-semibold">{rep.repName}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-gray-100 px-2 py-1">Leads {int(repLeadTotal(rep))}</span>
            <span>→</span>
            <span className="rounded bg-sky-50 px-2 py-1 text-sky-700">Sent {int(rep.sentThisWeek.count)}</span>
            <span>→</span>
            <span className="rounded bg-indigo-50 px-2 py-1 text-indigo-700">Projected {int(repProjectedTotal(rep))}</span>
            <span>→</span>
            <span className="rounded bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">Closed {int(rep.closed.count)}</span>
          </div>
          <CoverageCaption ladder={rep.projection} />
        </div>
      ))}
    </div>
  );
}

export function VariantB4ForecastLadder({ data }: { data: MondayShowcaseData }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
        Office forecast coverage: {data.officeProjection.coverageCaption}
      </div>
      {data.reps.map((rep) => {
        // per-rung "X of Y dated": the rung's count is the dated subset; Y is the rep's open-deal M.
        const m = rep.projection.coverage.m;
        return (
          <div key={rep.repId ?? "unassigned"} className="rounded-lg border bg-white p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-semibold">{rep.repName}</span>
              <span className="text-sm">
                Closed <span className="font-bold text-emerald-700">{int(rep.closed.count)}</span> · {usd(rep.closed.value.amount)}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {rep.projection.bands.map((b) => (
                <div key={b.band} className="rounded border p-2 text-center">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{PROJECTION_BAND_LABEL[b.band]}</div>
                  <div className="text-sm font-semibold">{usd(b.value)}</div>
                  <div className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                    {int(b.count)} of {int(m)} dated
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
