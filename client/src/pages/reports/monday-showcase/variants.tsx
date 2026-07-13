import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  PROJECTION_BAND_LABEL,
  type MondayShowcaseData,
  type DepartmentMetric,
  type ProjectionLadder,
  type RepShowcaseRow,
  type EvidenceMetric,
  type EvidenceRequest,
} from "./types";
import { DrillNumber, DRILL_UNDERLINE } from "./drill";
import { usd, int, signed, ACCENT, BAND_BAR, DeltaChip, Sparkline, type AccentKey } from "../evidence-kit";
import { ScrollSyncX } from "../scroll-sync-x";
import { periodWord, shouldShowWowDelta } from "../week-mode";

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

/**
 * Blind-spot cards split the M − N complement of the four dated bands into stale past dates and dates that
 * were never submitted. Both remain clickable evidence lists; amber/rose styling keeps them distinct from
 * the violet dated bands.
 */
function BlindSpotCard({
  label,
  value,
  count,
  metric,
  request,
  emphasis,
}: {
  label: string;
  value: number;
  count: number;
  metric: "no_date" | "stale";
  request: EvidenceRequest;
  emphasis: "office" | "rep";
}) {
  const office = emphasis === "office";
  return (
    <DrillNumber request={request} className="block">
      <div className={`rounded-lg border ${office ? "border-amber-300" : "border-amber-200"} border-l-4 border-l-amber-500 bg-amber-50/70 p-2 text-center`}>
        <div className="flex items-center justify-center gap-1">
          <span className={`text-[10px] font-bold uppercase tracking-wide ${metric === "stale" ? "text-rose-700" : "text-amber-700"}`}>{label}</span>
        </div>
        <div className={`mt-0.5 text-sm tabular-nums text-slate-900 ${office ? "font-black" : "font-bold"}`}>
          {usd(value)}
        </div>
        <div className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] tabular-nums ${metric === "stale" ? "bg-rose-200 text-rose-800" : "bg-amber-200 text-amber-800"}`}>
          {int(Math.max(0, count))} {metric === "stale" ? "stale" : "no date"}
        </div>
      </div>
    </DrillNumber>
  );
}

// First load now defaults to "last full week" (completed), so any "this week" copy must follow the mode —
// otherwise last week's numbers render labelled "this week" until the user notices the toggle. The MTD/YTD
// modes get their own explicit words ("Month to date" / "Year to date") via the shared periodWord, so a
// month/year view is never mislabeled "last week". Aliased to keep the call sites terse.
const weekWord = periodWord;

export function VariantA3Lanes({ data }: { data: MondayShowcaseData }) {
  const lanes: Array<{ key: "estimating" | "sent" | "won"; label: string }> = [
    { key: "estimating", label: "Estimating" },
    { key: "sent", label: "Sent" },
    { key: "won", label: "Won" },
  ];
  const weeks = data.weeklyTrend.slice(-8);
  const lastIdx = weeks.length - 1;
  // A3 renders weeklyTrend; its displayed value is the LAST bucket — ALWAYS one Sunday-week, never the
  // page-period total. So A3 needs WEEKLY wording even when the page toggle is MTD/YTD (the shared
  // periodWord would mislabel a one-week number "Month/Year to date"). The last bucket is the current,
  // in-progress week in every mode EXCEPT "completed" (which returns the prior full Sun–Sat week); for
  // to_date/mtd/ytd the trend anchors on this week's Sunday and the bucket runs Sunday → today.
  const lastInProgress = data.period.mode !== "completed";
  const laneWord = lastInProgress ? "this week" : "last week";
  // Drill scoping (CodeRabbit P2 — reconciliation): in weekly modes (to_date/completed) the page period
  // EQUALS this last bucket, so A3's mode-scoped drill opens evidence that reconciles to the bar. In
  // MTD/YTD the page period is a whole month/year while the bar is still ONE week, so a mode-scoped drill
  // would open month/year evidence that does NOT match the clicked weekly number (card != drawer). The
  // evidence API can express an explicit {from,to} week, but assertShowcaseEvidenceAccess restricts an
  // explicit window to directors and the showcase is rep-accessible, so we can't make every viewer's
  // weekly drill carry it. We therefore make A3's weekly number NON-drillable in MTD/YTD (plain text), so
  // it can never open a mismatched drawer; A1/A2/Hero drill the period TOTAL and are unaffected.
  const weeklyDrillable = data.period.mode === "to_date" || data.period.mode === "completed";
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
                {laneWord}{" "}
                {weeklyDrillable ? (
                  <DrillNumber request={{ metric: DEPT_TO_METRIC[lane.key], title: `${lane.label} — ${laneWord}` }} className={`font-semibold ${accent.text} ${DRILL_UNDERLINE} px-0.5`}>
                    {int(current)}
                  </DrillNumber>
                ) : (
                  // MTD/YTD: a weekly bucket value — not drillable (would open period-scoped evidence).
                  <span className={`font-semibold ${accent.text} px-0.5 tabular-nums`}>{int(current)}</span>
                )}{" "}
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

// ---------------- Exec · One Glance (consolidation survivor: A1 + A2 + Hero) ----------------

// Hybrid survivor of the old A1 (Throughput Funnel), A2 (Department Scoreboard), and Hero (One-Glance):
// Hero's big gradient-tile presentation carrying A2's data richness. It renders all FOUR departments
// (incl. Collected — the metric A1/A2 surfaced that the old 3-tile Hero dropped) sourced from
// `data.departments`, where each metric's WoW DeltaChip and 8-week Sparkline live. Reading departments
// (not the leaner `data.execHero`) is what lets one tile carry count + value + delta + trend together; the
// core three still reconcile with execHero by construction (same server payload).
export function VariantExecHero({ data }: { data: MondayShowcaseData }) {
  const periodLabel = weekWord(data.period.mode);
  // The DeltaChip is week-over-week; its baseline (the 7 days before the period start) is meaningless for
  // MTD/YTD (whole month vs the last week of the prior month; Jan1–today vs Dec25–31). Hide it there —
  // the SAME rule the (removed) A2 scoreboard used, now shared via shouldShowWowDelta.
  const showWow = shouldShowWowDelta(data.period.mode);
  const spikeIndex = data.weeklyTrend.slice(-8).findIndex((w) => w.spikeExcluded);
  // Won-first exec emphasis, then the upstream funnel, then Collected (deferred finance source) last.
  const order: Array<DepartmentMetric["key"]> = ["won", "sent", "estimating", "collected"];
  const depts = order
    .map((k) => data.departments.find((d) => d.key === k))
    .filter((d): d is DepartmentMetric => Boolean(d));
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {depts.map((d) => {
        const accent = ACCENT[d.key as AccentKey];
        const tile = (
          <div
            className={`group relative h-full overflow-hidden rounded-2xl border bg-gradient-to-br to-white p-6 shadow-sm transition-shadow hover:shadow-md ${d.deferred ? "border-dashed border-slate-200 from-slate-50" : `border-slate-200 ${accent.grad}`}`}
          >
            <span className={`absolute inset-x-0 top-0 h-1 ${accent.bar}`} />
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">{d.label} {periodLabel}</div>
              <div className="flex items-center gap-1.5">
                {showWow && <DeltaChip delta={d.deltaCountWoW} />}
                {!d.deferred && <ArrowUpRight className="h-4 w-4 text-slate-300 transition-colors group-hover:text-slate-500" />}
              </div>
            </div>
            <div className={`mt-2 text-5xl font-extrabold tabular-nums ${d.deferred ? "text-slate-300" : accent.text}`}>
              {d.deferred ? "—" : int(d.count ?? 0)}
            </div>
            <div className="mt-1 text-sm font-medium tabular-nums text-slate-600">
              {d.deferred ? "deferred" : usd(d.value?.amount ?? 0)}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-400">{d.deferred ? "Awaiting finance source" : basisLabel(d)}</div>
            {d.sparkline.length > 0 && (
              <div className="mt-3">
                <Sparkline values={d.sparkline} spikeIndex={spikeIndex} barClass={accent.bar} highlightLast />
              </div>
            )}
          </div>
        );
        // Collected has no evidence cohort (deferred finance source), so it isn't drillable.
        return d.deferred || d.key === "collected" ? (
          <div key={d.key}>{tile}</div>
        ) : (
          <DrillNumber
            key={d.key}
            request={{ metric: DEPT_TO_METRIC[d.key as "estimating" | "sent" | "won"], title: `${d.label} — ${periodLabel}` }}
            className="block text-left"
          >
            {tile}
          </DrillNumber>
        );
      })}
    </div>
  );
}

// ---------------- Report B (per-rep) ----------------
// (B1 Roll-Call Scorecards removed in the consolidation — its per-rep Sent + lead-status content lives on
//  in B2 Leaderboard and B3 Rep Load Lane below.)

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
          {/* Per-stage lead drill (inherited from the removed B1 Roll-Call Scorecards): the "Leads N" pill
              above opens ALL active leads, but each lead stage is also independently drillable here so the
              stage-specific evidence B1 surfaced (leadStage-scoped) stays reachable on the consolidated B3. */}
          {rep.leadStatus.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-slate-400">by stage:</span>
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
          )}
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
        <div className="grid grid-cols-7 gap-2">
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
          {/* Split the M − N complement so stale dates are not conflated with deals that never had a date. */}
          <BlindSpotCard
            label="Stale date"
            value={data.officeProjection.blindSpots?.stale.value ?? 0}
            count={data.officeProjection.blindSpots?.stale.count ?? 0}
            metric="stale"
            request={{ metric: "stale", title: "Stale close date — office" }}
            emphasis="office"
          />
          <BlindSpotCard
            label="No date"
            value={data.officeProjection.blindSpots?.noDate.value ?? data.officeProjection.coverage.undatedValue}
            count={data.officeProjection.blindSpots?.noDate.count ?? Math.max(0, data.officeProjection.coverage.m - data.officeProjection.coverage.n)}
            metric="no_date"
            request={{ metric: "no_date", title: "No close date — office" }}
            emphasis="office"
          />
          {/* Total of all dated timelines sits at the far right, after the two exception columns. Omitting
              `band` makes the drawer open the all-bands office projection, which reconciles to the four
              dated band cells by construction. */}
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
            <div className="grid grid-cols-7 gap-2">
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
              {/* Per-rep blind spot (M − N): this rep's open deals with no future-dated close date. Sums
                  to the office card by construction (officeProjection = Σ per-rep). */}
              <BlindSpotCard
                label="Stale date"
                value={rep.projection.blindSpots?.stale.value ?? 0}
                count={rep.projection.blindSpots?.stale.count ?? 0}
                metric="stale"
                request={{ metric: "stale", repId: rep.repId, title: `${rep.repName} — Stale close date` }}
                emphasis="rep"
              />
              <BlindSpotCard
                label="No date"
                value={rep.projection.blindSpots?.noDate.value ?? rep.projection.coverage.undatedValue}
                count={rep.projection.blindSpots?.noDate.count ?? Math.max(0, rep.projection.coverage.m - rep.projection.coverage.n)}
                metric="no_date"
                request={{ metric: "no_date", repId: rep.repId, title: `${rep.repName} — No close date` }}
                emphasis="rep"
              />
              {/* Total of all dated timelines is the final column. Band omitted -> all-bands drill; it
                  reconciles to the four dated band cells (and the office Total = Σ per-rep Totals). */}
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
