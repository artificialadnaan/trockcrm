import { useMemo, useState } from "react";
import { Loader2, TrendingUp, TrendingDown, Sparkles, Trophy, XCircle } from "lucide-react";
import { useRegionReport } from "@/hooks/use-reports";
import { PresetSelect } from "@/components/filters/preset-select";
import { usd, int, Sparkline } from "./evidence-kit";
import {
  REGION_PERIOD_OPTIONS,
  resolveRegionPeriod,
  pctLabel,
  heatIntensity,
  type RegionPeriodKey,
} from "./region-report";
import {
  PROJECTION_BAND_ORDER,
  PROJECTION_BAND_LABEL,
  type RegionReportData,
  type RegionRow,
  type RegionMoverDeal,
} from "./region-report-types";

// A small badge marking whether a metric responds to the period toggle (windowed on event dates) or is a
// live snapshot (pipeline/forecast/stage-matrix) — so nobody reads a snapshot as period-scoped.
function ScopeBadge({ snapshot }: { snapshot?: boolean }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
        snapshot ? "bg-slate-100 text-slate-500" : "bg-indigo-50 text-indigo-600"
      }`}
      title={snapshot ? "A live snapshot — does NOT change with the period toggle" : "Windowed by the selected period"}
    >
      {snapshot ? "snapshot · now" : "this period"}
    </span>
  );
}

function SummaryCard({
  label,
  primary,
  sub,
  snapshot,
  tone = "bg-slate-300",
}: {
  label: string;
  primary: string;
  sub?: string;
  snapshot?: boolean;
  tone?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4">
      <span className={`absolute inset-y-0 left-0 w-1 ${tone}`} />
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <ScopeBadge snapshot={snapshot} />
      </div>
      <div className="mt-1 text-2xl font-extrabold tabular-nums text-slate-800">{primary}</div>
      {sub ? <div className="text-xs tabular-nums text-slate-400">{sub}</div> : null}
    </div>
  );
}

function SummaryCards({ data }: { data: RegionReportData }) {
  const s = data.summary;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard label="Total Won" primary={usd(s.totalWon.value)} sub={`${int(s.totalWon.count)} deals`} tone="bg-emerald-500" />
      <SummaryCard label="Open Pipeline" primary={usd(s.openPipeline.value)} sub={`${int(s.openPipeline.count)} open deals`} snapshot tone="bg-indigo-500" />
      <SummaryCard label="Win Rate" primary={pctLabel(s.winRate)} sub="won / (won + lost)" tone="bg-sky-500" />
      <SummaryCard
        label="Unassigned %"
        primary={pctLabel(s.unassignedPct)}
        sub="of open pipeline has no region"
        snapshot
        tone="bg-amber-500"
      />
    </div>
  );
}

function MoverDealChip({
  icon,
  title,
  basis,
  deal,
}: {
  icon: React.ReactNode;
  title: string;
  basis: string;
  deal: RegionMoverDeal | null;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {title}
        <span className="ml-auto rounded bg-slate-100 px-1 py-0.5 text-[9px] font-medium text-slate-400">{basis}</span>
      </div>
      {deal ? (
        <div className="mt-1">
          <div className="truncate text-sm font-medium text-slate-800" title={deal.name}>
            {deal.name}
          </div>
          <div className="text-xs tabular-nums text-slate-500">
            {usd(deal.value)} · <span className="text-slate-400">{deal.region}</span>
          </div>
        </div>
      ) : (
        <div className="mt-1 text-sm text-slate-400">—</div>
      )}
    </div>
  );
}

function MoversStrip({ movers }: { movers: RegionReportData["movers"] }) {
  const m = movers.biggestRegionMover;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">What changed this week</h2>
        <span className="text-[11px] text-slate-400">{movers.weekLabel}</span>
        <span className="text-[10px] italic text-slate-400">always the current week — independent of the period toggle</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {m && m.deltaWon >= 0 ? <TrendingUp className="h-3.5 w-3.5 text-emerald-600" /> : <TrendingDown className="h-3.5 w-3.5 text-red-600" />}
            Biggest region mover
            <span className="ml-auto rounded bg-slate-100 px-1 py-0.5 text-[9px] font-medium text-slate-400">won Δ</span>
          </div>
          {m ? (
            <div className="mt-1">
              <div className="text-sm font-medium text-slate-800">{m.region}</div>
              <div className={`text-xs font-semibold tabular-nums ${m.deltaWon >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                {m.deltaWon >= 0 ? "+" : "−"}
                {usd(Math.abs(m.deltaWon))} <span className="font-normal text-slate-400">vs last week</span>
              </div>
            </div>
          ) : (
            <div className="mt-1 text-sm text-slate-400">—</div>
          )}
        </div>
        <MoverDealChip icon={<Sparkles className="h-3.5 w-3.5 text-indigo-500" />} title="Biggest new deal" basis="open" deal={movers.biggestNewDeal} />
        <MoverDealChip icon={<Trophy className="h-3.5 w-3.5 text-emerald-600" />} title="Biggest win" basis="won" deal={movers.biggestWin} />
        <MoverDealChip icon={<XCircle className="h-3.5 w-3.5 text-red-500" />} title="Biggest loss" basis="lost" deal={movers.biggestLoss} />
      </div>
    </section>
  );
}

function RegionCard({ r }: { r: RegionRow }) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-white p-4 ${
        r.isUnassigned ? "border-amber-300 bg-amber-50/40" : "border-slate-200"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-slate-800">{r.region}</div>
        {r.isUnassigned ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">no region set</span>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        <Metric label="Won" value={usd(r.won.value)} sub={`${int(r.won.count)} deals`} />
        <Metric label="Pipeline" value={usd(r.pipeline.value)} sub={`${int(r.pipeline.count)} open`} />
        <Metric label="Win rate" value={pctLabel(r.winRate)} />
        <Metric label="Avg deal" value={r.avgDeal == null ? "—" : usd(r.avgDeal)} />
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">8-week won trend</div>
        <Sparkline values={r.sparkline} barClass={r.isUnassigned ? "bg-amber-400" : "bg-emerald-500"} highlightLast height={32} />
      </div>
      {r.isUnassigned ? (
        <p className="mt-2 text-[11px] text-amber-700">Set a region on these deals so they roll into a region above.</p>
      ) : null}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-semibold tabular-nums text-slate-800">{value}</div>
      {sub ? <div className="text-[10px] tabular-nums text-slate-400">{sub}</div> : null}
    </div>
  );
}

function RegionCards({ regions }: { regions: RegionRow[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">By region</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {regions.map((r) => (
          <RegionCard key={r.region} r={r} />
        ))}
      </div>
    </section>
  );
}

const BAND_TONE: Record<(typeof PROJECTION_BAND_ORDER)[number], string> = {
  "0_30": "bg-emerald-500",
  "31_60": "bg-sky-500",
  "61_90": "bg-violet-500",
  beyond_90: "bg-slate-400",
};

function ForecastSection({ regions }: { regions: RegionRow[] }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Forecast — projected to close</h2>
        <ScopeBadge snapshot />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {regions.map((r) => {
          const { n, m } = r.forecast.coverage;
          return (
            <div key={r.region} className="rounded-xl border border-slate-200 bg-white p-3.5">
              <div className="mb-2 font-semibold text-slate-800">{r.region}</div>
              <div className="grid grid-cols-4 gap-2">
                {PROJECTION_BAND_ORDER.map((band) => {
                  const cell = r.forecast.bands[band];
                  return (
                    <div key={band} className="rounded-lg border border-slate-200 p-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <span className={`h-1.5 w-1.5 rounded-full ${BAND_TONE[band]}`} />
                        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{PROJECTION_BAND_LABEL[band]}</span>
                      </div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-800">{usd(cell.value)}</div>
                      <div className="text-[10px] tabular-nums text-slate-400">{int(cell.count)} dated</div>
                    </div>
                  );
                })}
              </div>
              {/* MANDATORY honesty caption — most open deals are past-dated/undated, so the ladder covers only part. */}
              <p className="mt-2 text-[11px] text-slate-500">
                <span className="font-semibold tabular-nums text-slate-700">
                  {int(n)} of {int(m)}
                </span>{" "}
                open deals have a live close date{m > 0 && n < m ? " — the rest are forecast blind spots" : ""}.
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StageHeatmap({ data }: { data: RegionReportData }) {
  const maxValue = Math.max(0, ...data.stageMatrix.map((c) => c.value));
  const cellOf = (region: string, slug: string) => data.stageMatrix.find((c) => c.region === region && c.stageSlug === slug);
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Stage distribution by region</h2>
        <ScopeBadge snapshot />
        <span className="text-[11px] text-slate-400">colour = $ value · number = deal count</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table
          className="w-full text-sm"
          aria-label="Open deals by region (rows) and pipeline stage (columns). The number is the deal count; the cell shade encodes total $ value (darker = more)."
        >
          <thead className="border-b border-slate-100 bg-[#f7f8fb] text-[11px] font-black uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2.5 text-left">Region</th>
              {data.stageColumns.map((col) => (
                <th key={col.slug} className="px-3 py-2.5 text-center">
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.regions.map((r) => (
              <tr key={r.region} className={`border-b border-slate-50 last:border-0 ${r.isUnassigned ? "bg-amber-50" : ""}`}>
                <td className={`px-3 py-2.5 font-medium ${r.isUnassigned ? "text-amber-700" : "text-slate-700"}`}>{r.region}</td>
                {data.stageColumns.map((col) => {
                  const cell = cellOf(r.region, col.slug);
                  const count = cell?.count ?? 0;
                  const value = cell?.value ?? 0;
                  const intensity = heatIntensity(value, maxValue);
                  // Cap the shade so the count (the dual-encoding's other half) keeps a readable contrast
                  // ratio against dark text at every intensity — no white-on-mid-indigo dead zone.
                  return (
                    <td key={`${r.region}-${col.slug}`} className="px-1.5 py-1.5 text-center">
                      <div
                        className="rounded-md px-2 py-1.5 tabular-nums"
                        style={{
                          backgroundColor: count > 0 ? `rgba(79, 70, 229, ${0.06 + intensity * 0.55})` : "transparent",
                          color: count > 0 ? "rgb(30 41 59)" : "rgb(203 213 225)",
                        }}
                        title={count > 0 ? `${int(count)} deals · ${usd(value)}` : "no open deals"}
                      >
                        <span className="text-sm font-semibold">{count > 0 ? int(count) : "·"}</span>
                        {count > 0 ? <span className="ml-1 text-[10px] text-slate-500">{usd(value)}</span> : null}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 px-1 text-[10px] text-slate-400">
        <span>$ value</span>
        <span className="inline-flex h-2.5 w-24 rounded-full" style={{ background: "linear-gradient(to right, rgba(79,70,229,0.06), rgba(79,70,229,0.61))" }} />
        <span>low → high</span>
        <span className="ml-2">· number = deal count</span>
      </div>
    </section>
  );
}

function TopRepsSection({ regions }: { regions: RegionRow[] }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Top reps within region</h2>
        <ScopeBadge />
        <span className="text-[11px] text-slate-400">ranked by won value in the period</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {regions.map((r) => (
          <div key={r.region} className="rounded-xl border border-slate-200 bg-white p-3.5">
            <div className="mb-2 font-semibold text-slate-800">{r.region}</div>
            {r.topReps.length === 0 ? (
              <div className="text-xs text-slate-400">No won deals this period.</div>
            ) : (
              <ol className="space-y-1.5">
                {r.topReps.map((rep, i) => (
                  <li key={rep.repId ?? `unassigned-${i}`} className="flex items-center gap-2 text-sm">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-500">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-slate-700">{rep.repName}</span>
                    <span className="tabular-nums font-semibold text-emerald-700">{usd(rep.wonValue)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function RegionReportPage() {
  const [periodKey, setPeriodKey] = useState<RegionPeriodKey>("mtd");
  const { from, to } = useMemo(() => resolveRegionPeriod(periodKey), [periodKey]);
  const { data, loading, error } = useRegionReport(from, to);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Reports · Region</p>
          <h1 className="text-2xl font-bold">Reports by Region</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Performance by deal Region (West Coast / Central / East Coast + Unassigned). Won, win rate and avg
            deal are windowed by the period; pipeline, forecast and stage mix are live snapshots.
          </p>
        </div>
        <PresetSelect
          ariaLabel="Period"
          label="Period"
          value={periodKey}
          options={REGION_PERIOD_OPTIONS}
          onChange={(v) => setPeriodKey(v as RegionPeriodKey)}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-5">
          <SummaryCards data={data} />
          <MoversStrip movers={data.movers} />
          <RegionCards regions={data.regions} />
          <ForecastSection regions={data.regions} />
          <StageHeatmap data={data} />
          <TopRepsSection regions={data.regions} />
        </div>
      ) : null}
    </div>
  );
}
