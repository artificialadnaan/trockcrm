import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  PROJECTION_BAND_LABEL,
  type MondayShowcaseData,
  type DepartmentMetric,
  type ProjectionLadder,
  type RepShowcaseRow,
  type EvidenceMetric,
} from "./types";
import { DrillNumber, DRILL_UNDERLINE } from "./drill";
import { usd, int, signed, ACCENT, BAND_BAR, DeltaChip, Sparkline, type AccentKey } from "../evidence-kit";
import { ScrollSyncX } from "../scroll-sync-x";

// Every variant below renders a slice of the SAME payload -- so Won/Sent/Estimated/Projection figures
// are identical across all of them by construction (locked server-side by the reconciliation test). Every
// number is wrapped in <DrillNumber> so a click opens the EXACT records behind it (Reports Part 3).
// Palette + formatters + DeltaChip/Sparkline live in ../evidence-kit (shared with the Part-4 views).

// A department key maps to its evidence metric (the "estimating" department is the "estimated" cohort).
const DEPT_TO_METRIC: Record<"estimating" | "sent" | "won", EvidenceMetric> = {
  estimating: "estimated",
  sent: "sent",
  won: "won",
};

function basisLabel(metric: { value: { basisLabel: string } | null }) {
  return metric.value?.basisLabel ?? "";
}

function CoverageCaption({ ladder }: { ladder: ProjectionLadder }) {
  return <p className="mt-1 text-[11px] text-slate-400">{ladder.coverageCaption}</p>;
}

/** Per-rep projection rungs, band-colored and each drillable to its rung's deals. */
function ProjectionRungs({
  ladder,
  repId,
  repName,
  compact = false,
}: {
  ladder: ProjectionLadder;
  repId: string | null;
  repName: string;
  compact?: boolean;
}) {
  return (
    <div className={`grid grid-cols-4 ${compact ? "gap-1.5" : "gap-2"}`}>
      {ladder.bands.map((b) => (
        <DrillNumber
          key={b.band}
          request={{ metric: "projection", repId, band: b.band, title: `${repName} — Projected ${PROJECTION_BAND_LABEL[b.band]}` }}
          className="block"
        >
          <div className="rounded-lg border border-slate-200 bg-white p-2 text-center">
            <div className="flex items-center justify-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${BAND_BAR[b.band]}`} />
              <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{PROJECTION_BAND_LABEL[b.band]}</span>
            </div>
            <div className="mt-0.5 text-base font-bold tabular-nums text-slate-800">{int(b.count)}</div>
            <div className="text-[10px] tabular-nums text-slate-400">{usd(b.value)}</div>
          </div>
        </DrillNumber>
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
        {depts.map((d, i) => {
          const accent = ACCENT[d.key as AccentKey];
          const tile = (
            <div
              className={`relative min-w-[160px] overflow-hidden rounded-xl border bg-gradient-to-b to-white p-3.5 ${d.deferred ? "border-dashed border-slate-200 from-slate-50" : `border-slate-200 ${accent.grad}`}`}
            >
              <span className={`absolute inset-y-0 left-0 w-1 ${accent.bar}`} />
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{d.label}</div>
                {!d.deferred && <ArrowUpRight className="h-3.5 w-3.5 text-slate-300" />}
              </div>
              <div className={`mt-1 text-3xl font-extrabold tabular-nums ${d.deferred ? "text-slate-300" : accent.text}`}>
                {d.deferred ? "—" : int(d.count ?? 0)}
              </div>
              <div className="text-[11px] tabular-nums text-slate-400">
                {d.deferred ? "deferred" : `${usd(d.value?.amount ?? 0)} · ${basisLabel(d)}`}
              </div>
            </div>
          );
          return (
            <div key={d.key} className="flex items-center gap-2">
              {d.deferred || d.key === "collected" ? (
                tile
              ) : (
                <DrillNumber
                  request={{ metric: DEPT_TO_METRIC[d.key as "estimating" | "sent" | "won"], title: `${d.label} — ${weekWord(data.period.mode)}` }}
                  className="block"
                >
                  {tile}
                </DrillNumber>
              )}
              {i < depts.length - 1 && <div className="text-xl text-slate-300">›</div>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-400">
        Same-week throughput, not a cohort conversion — Estimated/Sent are stage-entry cohorts, Won is a close-date cohort.
      </p>
    </div>
  );
}

// First load now defaults to "last full week" (completed), so any "this week" copy must follow the mode —
// otherwise last week's numbers render labelled "this week" until the user notices the toggle.
const weekWord = (mode: MondayShowcaseData["period"]["mode"]) => (mode === "to_date" ? "this week" : "last week");

export function VariantA2Scoreboard({ data }: { data: MondayShowcaseData }) {
  const spikeIndex = data.weeklyTrend.slice(-8).findIndex((w) => w.spikeExcluded);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {data.departments.map((d) => {
        const accent = ACCENT[d.key as AccentKey];
        const inner = (
          <div className={`relative h-full overflow-hidden rounded-xl border p-3.5 ${d.deferred ? "border-dashed border-slate-200 bg-slate-50" : "border-slate-200 bg-white"}`}>
            <span className={`absolute inset-y-0 left-0 w-1 ${accent.bar}`} />
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{d.label}</span>
              <DeltaChip delta={d.deltaCountWoW} />
            </div>
            <div className={`mt-1 text-3xl font-extrabold tabular-nums ${d.deferred ? "text-slate-300" : accent.text}`}>
              {d.deferred ? "—" : int(d.count ?? 0)}
            </div>
            <div className="text-[11px] tabular-nums text-slate-400">
              {d.deferred ? "Awaiting finance source" : `${usd(d.value?.amount ?? 0)} · ${basisLabel(d)}`}
            </div>
            {!d.deferred && d.sparkline.length > 0 && (
              <div className="mt-2">
                <Sparkline values={d.sparkline} spikeIndex={spikeIndex} barClass={accent.bar} highlightLast />
              </div>
            )}
          </div>
        );
        return d.deferred || d.key === "collected" ? (
          <div key={d.key}>{inner}</div>
        ) : (
          <DrillNumber
            key={d.key}
            request={{ metric: DEPT_TO_METRIC[d.key as "estimating" | "sent" | "won"], title: `${d.label} — ${weekWord(data.period.mode)}` }}
            className="block text-left"
          >
            {inner}
          </DrillNumber>
        );
      })}
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
  // The last bucket is only "in progress" in the live week-to-date view; in completed-week mode the
  // server returned a full prior Sun-Sat week, so don't mislabel it.
  const lastInProgress = data.period.mode === "to_date";
  return (
    <div className="space-y-4">
      {lanes.map((lane) => {
        const accent = ACCENT[lane.key];
        const series = weeks.map((w) => w[lane.key]);
        const usable = weeks.filter((w) => !w.spikeExcluded).map((w) => w[lane.key]);
        const avg = usable.length ? usable.reduce((s, v) => s + v, 0) / usable.length : 0;
        const current = series[lastIdx] ?? 0;
        const delta = Math.round(current - avg);
        const max = Math.max(1, ...series);
        return (
          <div key={lane.key} className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3.5">
            <span className={`absolute inset-y-0 left-0 w-1 ${accent.bar}`} />
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${accent.bar}`} />
                <span className="text-sm font-semibold text-slate-700">{lane.label}</span>
              </div>
              <span className="text-xs text-slate-400">
                {weekWord(data.period.mode)}{" "}
                <DrillNumber request={{ metric: DEPT_TO_METRIC[lane.key], title: `${lane.label} — ${weekWord(data.period.mode)}` }} className={`font-semibold ${accent.text} ${DRILL_UNDERLINE} px-0.5`}>
                  {int(current)}
                </DrillNumber>{" "}
                · 8wk avg <span className="tabular-nums">{avg.toFixed(1)}</span>{" "}
                <span className={delta > 0 ? "text-emerald-600" : delta < 0 ? "text-rose-600" : "text-slate-400"}>({signed(delta)})</span>
                {lastInProgress && <span className="ml-1 italic text-slate-400">· current week in progress</span>}
              </span>
            </div>
            <div className="flex h-20 items-end gap-1.5">
              {series.map((v, i) => {
                const spike = weeks[i]?.spikeExcluded;
                const isLast = i === lastIdx && lastInProgress;
                return (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      title={spike ? `${v} (spike — excluded from avg)` : isLast ? `${v} (in progress)` : String(v)}
                      className={`w-full rounded-t transition-all ${spike ? "bg-amber-400" : isLast ? `${accent.bar} opacity-50` : accent.bar} ${i === lastIdx ? "ring-2 ring-slate-300 ring-offset-1" : ""}`}
                      style={{ height: `${Math.max(3, (v / max) * 64)}px` }}
                    />
                    <span className="text-[9px] tabular-nums text-slate-400">{weeks[i]?.weekStart.slice(5)}</span>
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
  const periodLabel = weekWord(data.period.mode);
  const tiles: Array<{ label: string; metric: EvidenceMetric; accent: AccentKey; value: { count: number; value: { amount: number; basisLabel: string } } }> = [
    { label: "Won", metric: "won", accent: "won", value: data.execHero.won },
    { label: "Sent", metric: "sent", accent: "sent", value: data.execHero.sent },
    { label: "Estimated", metric: "estimated", accent: "estimating", value: data.execHero.estimated },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {tiles.map((t) => {
        const accent = ACCENT[t.accent];
        return (
          <DrillNumber
            key={t.label}
            request={{ metric: t.metric, title: `${t.label} — ${periodLabel}` }}
            className="block text-left"
          >
            <div className={`group relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br to-white p-6 shadow-sm transition-shadow hover:shadow-md ${accent.grad}`}>
              <span className={`absolute inset-x-0 top-0 h-1 ${accent.bar}`} />
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">{t.label} {periodLabel}</div>
                <ArrowUpRight className="h-4 w-4 text-slate-300 transition-colors group-hover:text-slate-500" />
              </div>
              <div className={`mt-2 text-5xl font-extrabold tabular-nums ${accent.text}`}>{int(t.value.count)}</div>
              <div className="mt-1 text-sm font-medium tabular-nums text-slate-600">{usd(t.value.value.amount)}</div>
              <div className="mt-0.5 text-[10px] text-slate-400">{t.value.value.basisLabel}</div>
            </div>
          </DrillNumber>
        );
      })}
    </div>
  );
}

// ---------------- Report B (per-rep) ----------------

export function VariantB1Scorecards({ data }: { data: MondayShowcaseData }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {data.reps.map((rep) => (
        <div key={rep.repId ?? "unassigned"} className="rounded-xl border border-slate-200 bg-white p-3.5">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold text-slate-800">{rep.repName}</span>
            <span className="text-sm text-slate-500">
              <DrillNumber request={{ metric: "won", repId: rep.repId, title: `${rep.repName} — Won` }} className={`font-bold text-emerald-700 ${DRILL_UNDERLINE} px-0.5`}>
                {int(rep.closed.count)}
              </DrillNumber>{" "}
              closed · <span className="tabular-nums">{usd(rep.closed.value.amount)}</span>
            </span>
          </div>
          <div className="mt-2">
            <ProjectionRungs ladder={rep.projection} repId={rep.repId} repName={rep.repName} compact />
          </div>
          <CoverageCaption ladder={rep.projection} />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <DrillNumber request={{ metric: "sent", repId: rep.repId, title: `${rep.repName} — Sent` }} className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-700 ring-1 ring-sky-200">
              Sent {int(rep.sentThisWeek.count)}
            </DrillNumber>
            {rep.leadStatus.map((ls) => (
              <DrillNumber
                key={ls.stageLabel}
                request={{ metric: "leads", repId: rep.repId, leadStage: ls.stageLabel, title: `${rep.repName} — ${ls.stageLabel} leads` }}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 ring-1 ring-slate-200"
              >
                {ls.stageLabel}: {int(ls.count)}
              </DrillNumber>
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
  // Footer totals read the CANONICAL office aggregates from the payload — the SAME server numbers each
  // footer drill opens (Won/Sent/projection are office-scoped). The per-rep rows need not partition the
  // office exactly (e.g. unassigned wins may be absent from the rep rows), so summing the rows could differ
  // from the office aggregate. Reading the office figures here makes footer === drawer by construction.
  const totals = {
    closed: data.execHero.won.value.amount, // office Won $ (getWonCloseSummary) — what the Won-office drill opens
    closedCount: data.execHero.won.count,
    projected: data.officeProjection.bands.reduce((s, b) => s + b.count, 0), // office projection ladder
    sent: data.execHero.sent.count, // office Sent
    leads: data.reps.reduce((s, r) => s + repLeadTotal(r), 0), // office leads = every rep bucket incl. Unassigned
  };
  const Th = ({ k, children }: { k: SortKey; children: ReactNode }) => (
    <th
      className={`cursor-pointer px-3 py-2 text-right transition-colors ${sort === k ? "text-slate-800 underline decoration-2 underline-offset-4" : "text-slate-400 hover:text-slate-600"}`}
      onClick={() => setSort(k)}
    >
      {children}
    </th>
  );
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <ScrollSyncX bodyClassName="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 bg-[#f7f8fb] text-[11px] font-black uppercase tracking-wide">
          <tr>
            <th className="px-3 py-2.5 text-left text-slate-500">Rep</th>
            <Th k="closed">Closed $</Th>
            <Th k="projected">Projected #</Th>
            <Th k="sent">Sent</Th>
            <Th k="leads">Active leads</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.repId ?? "unassigned"} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
              <td className="px-3 py-2.5">
                <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-500">{i + 1}</span>
                <span className="font-medium text-slate-700">{r.repName}</span>
              </td>
              <td className="px-3 py-2.5 text-right">
                <DrillNumber request={{ metric: "won", repId: r.repId, title: `${r.repName} — Won` }} className={`font-semibold tabular-nums text-emerald-700 ${DRILL_UNDERLINE} px-0.5`}>
                  {usd(r.closed.value.amount)}
                </DrillNumber>
              </td>
              <td className="px-3 py-2.5 text-right">
                <DrillNumber request={{ metric: "projection", repId: r.repId, title: `${r.repName} — Projected (all)` }} className={`tabular-nums text-slate-700 ${DRILL_UNDERLINE} px-0.5`}>
                  {int(repProjectedTotal(r))}
                </DrillNumber>
              </td>
              <td className="px-3 py-2.5 text-right">
                <DrillNumber request={{ metric: "sent", repId: r.repId, title: `${r.repName} — Sent` }} className={`tabular-nums text-slate-700 ${DRILL_UNDERLINE} px-0.5`}>
                  {int(r.sentThisWeek.count)}
                </DrillNumber>
              </td>
              <td className="px-3 py-2.5 text-right">
                <DrillNumber request={{ metric: "leads", repId: r.repId, title: `${r.repName} — Active leads` }} className={`tabular-nums text-slate-700 ${DRILL_UNDERLINE} px-0.5`}>
                  {int(repLeadTotal(r))}
                </DrillNumber>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-slate-200 bg-[#f7f8fb] font-semibold">
          <tr>
            <td className="px-3 py-2.5 text-left text-slate-600">TOTAL ({int(totals.closedCount)} won)</td>
            <td className="px-3 py-2.5 text-right">
              <DrillNumber request={{ metric: "won", title: "Won — office" }} className={`tabular-nums text-emerald-700 ${DRILL_UNDERLINE} px-0.5`}>
                {usd(totals.closed)}
              </DrillNumber>
            </td>
            <td className="px-3 py-2.5 text-right">
              <DrillNumber request={{ metric: "projection", title: "Projected — office" }} className={`tabular-nums text-slate-700 ${DRILL_UNDERLINE} px-0.5`}>
                {int(totals.projected)}
              </DrillNumber>
            </td>
            <td className="px-3 py-2.5 text-right">
              <DrillNumber request={{ metric: "sent", title: "Sent — office" }} className={`tabular-nums text-slate-700 ${DRILL_UNDERLINE} px-0.5`}>
                {int(totals.sent)}
              </DrillNumber>
            </td>
            <td className="px-3 py-2.5 text-right">
              <DrillNumber request={{ metric: "leads", title: "Active leads — office" }} className={`tabular-nums text-slate-700 ${DRILL_UNDERLINE} px-0.5`}>
                {int(totals.leads)}
              </DrillNumber>
            </td>
          </tr>
        </tfoot>
      </table>
      </ScrollSyncX>
      <p className="px-3 py-2 text-xs text-slate-400">Footer totals are the canonical office aggregates — the exact numbers each TOTAL drills into — so the rep rows above need not sum to them when there is unassigned activity. Click a column header to re-rank; click any number for its records.</p>
    </div>
  );
}

export function VariantB3LoadLane({ data }: { data: MondayShowcaseData }) {
  return (
    <div className="space-y-3">
      {data.reps.map((rep) => (
        <div key={rep.repId ?? "unassigned"} className="rounded-xl border border-slate-200 bg-white p-3.5">
          <div className="mb-2 font-semibold text-slate-800">{rep.repName}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <DrillNumber request={{ metric: "leads", repId: rep.repId, title: `${rep.repName} — Active leads` }} className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700 ring-1 ring-amber-200">
              Leads {int(repLeadTotal(rep))}
            </DrillNumber>
            <span className="text-slate-300">→</span>
            <DrillNumber request={{ metric: "sent", repId: rep.repId, title: `${rep.repName} — Sent` }} className="rounded-full bg-sky-50 px-2.5 py-1 font-medium text-sky-700 ring-1 ring-sky-200">
              Sent {int(rep.sentThisWeek.count)}
            </DrillNumber>
            <span className="text-slate-300">→</span>
            <DrillNumber request={{ metric: "projection", repId: rep.repId, title: `${rep.repName} — Projected (all)` }} className="rounded-full bg-violet-50 px-2.5 py-1 font-medium text-violet-700 ring-1 ring-violet-200">
              Projected {int(repProjectedTotal(rep))}
            </DrillNumber>
            <span className="text-slate-300">→</span>
            <DrillNumber request={{ metric: "won", repId: rep.repId, title: `${rep.repName} — Won` }} className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 ring-1 ring-emerald-200">
              Closed {int(rep.closed.count)}
            </DrillNumber>
          </div>
          <CoverageCaption ladder={rep.projection} />
        </div>
      ))}
    </div>
  );
}

export function VariantB4ForecastLadder({ data }: { data: MondayShowcaseData }) {
  // Σ value across the office projection bands — computed once and reused by both the header "projected"
  // caption and the "Total of all timelines" cell so the two can never drift.
  const officeTotalValue = data.officeProjection.bands.reduce((sum, b) => sum + b.value, 0);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-violet-200 bg-gradient-to-r from-violet-50 to-white p-3 text-sm text-violet-900">
        <span className="font-semibold">Office forecast coverage:</span> {data.officeProjection.coverageCaption}
      </div>

      {/* Office column totals (HEADER): the canonical officeProjection ladder, surfaced at the top so the
          office forecast is the first thing visible. It equals the sum of the per-rep rows below BY
          CONSTRUCTION — the rep rows are union-seeded from the same per-rep projection map and
          officeProjection = Σ per-rep — so each window's $ and dated count always reconcile with the rows
          below (the showcase's one-source-of-truth guarantee). Distinct styling marks it the total. */}
      <div className="rounded-xl border-2 border-slate-300 bg-[#f7f8fb] p-3.5 font-semibold">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-black uppercase tracking-wide text-slate-700">All reps · office total</span>
          <span className="text-xs font-bold tabular-nums text-slate-600">
            {usd(officeTotalValue)} projected
          </span>
        </div>
        <div className="grid grid-cols-5 gap-2">
          {data.officeProjection.bands.map((b) => (
            <DrillNumber
              key={b.band}
              request={{ metric: "projection", band: b.band, title: `Projected ${PROJECTION_BAND_LABEL[b.band]} — office` }}
              className="block"
            >
              <div className="rounded-lg border border-slate-300 bg-white p-2 text-center">
                <div className="flex items-center justify-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${BAND_BAR[b.band]}`} />
                  <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{PROJECTION_BAND_LABEL[b.band]}</span>
                </div>
                <div className="mt-0.5 text-sm font-black tabular-nums text-slate-900">{usd(b.value)}</div>
                <div className="mt-1 inline-block rounded bg-slate-200 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-600">
                  {int(b.count)} dated
                </div>
              </div>
            </DrillNumber>
          ))}
          {/* Total of all timelines: Σ across every band. Omitting `band` makes the drawer open the
              band-less (all-bands) office projection, which reconciles to the four band cells by construction. */}
          <DrillNumber
            request={{ metric: "projection", title: "Projected all timelines — office" }}
            className="block"
          >
            <div className="rounded-lg border border-slate-300 border-l-4 border-l-violet-500 bg-violet-50/60 p-2 text-center">
              <div className="flex items-center justify-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-violet-600">Total</span>
              </div>
              <div className="mt-0.5 text-sm font-black tabular-nums text-slate-900">
                {usd(officeTotalValue)}
              </div>
              <div className="mt-1 inline-block rounded bg-violet-200 px-1.5 py-0.5 text-[10px] tabular-nums text-violet-800">
                {int(data.officeProjection.bands.reduce((sum, b) => sum + b.count, 0))} dated
              </div>
            </div>
          </DrillNumber>
        </div>
      </div>

      {data.reps.map((rep) => {
        // Each rung's count is the dated subset in that horizon; the coverage (how much of the rep's open
        // book has a maintained close date) is stated ONCE below the ladder, not repeated per rung — so the
        // denominator can't be misread as a per-rung total when scanning the four rungs.
        return (
          <div key={rep.repId ?? "unassigned"} className="rounded-xl border border-slate-200 bg-white p-3.5">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-semibold text-slate-800">{rep.repName}</span>
              <span className="text-sm text-slate-500">
                Closed{" "}
                <DrillNumber request={{ metric: "won", repId: rep.repId, title: `${rep.repName} — Won` }} className={`font-bold text-emerald-700 ${DRILL_UNDERLINE} px-0.5`}>
                  {int(rep.closed.count)}
                </DrillNumber>{" "}
                · <span className="tabular-nums">{usd(rep.closed.value.amount)}</span>
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {rep.projection.bands.map((b) => (
                <DrillNumber
                  key={b.band}
                  request={{ metric: "projection", repId: rep.repId, band: b.band, title: `${rep.repName} — Projected ${PROJECTION_BAND_LABEL[b.band]}` }}
                  className="block"
                >
                  <div className="rounded-lg border border-slate-200 p-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <span className={`h-1.5 w-1.5 rounded-full ${BAND_BAR[b.band]}`} />
                      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{PROJECTION_BAND_LABEL[b.band]}</span>
                    </div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-800">{usd(b.value)}</div>
                    <div className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500">
                      {int(b.count)} dated
                    </div>
                  </div>
                </DrillNumber>
              ))}
              {/* Total of all timelines: Σ across this rep's bands. Band omitted -> all-bands drill; reconciles
                  to the four band cells by construction (and the office Total = Σ of these per-rep Totals). */}
              <DrillNumber
                request={{ metric: "projection", repId: rep.repId, title: `${rep.repName} — Projected all timelines` }}
                className="block"
              >
                <div className="rounded-lg border border-slate-200 border-l-4 border-l-violet-400 bg-violet-50/50 p-2 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-violet-600">Total</span>
                  </div>
                  <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-800">
                    {usd(rep.projection.bands.reduce((sum, b) => sum + b.value, 0))}
                  </div>
                  <div className="mt-1 inline-block rounded bg-violet-100 px-1.5 py-0.5 text-[10px] tabular-nums text-violet-700">
                    {int(rep.projection.bands.reduce((sum, b) => sum + b.count, 0))} dated
                  </div>
                </div>
              </DrillNumber>
            </div>
            <p className="mt-2 text-[10px] text-slate-400">{rep.projection.coverageCaption}</p>
          </div>
        );
      })}
    </div>
  );
}
