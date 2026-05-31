import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useMondayShowcase } from "@/hooks/use-reports";
import { PROJECTION_BAND_LABEL, type EvidenceRequest, type MondayShowcaseData } from "./monday-showcase/types";
import { DrillProvider, DrillNumber, EvidenceDrawer, usd, int, BAND_BAR, Sparkline, DRILL_UNDERLINE } from "./evidence-kit";
import { DEFAULT_WEEK_MODE, type WeekMode } from "./week-mode";

// A·1 Forecast Confidence Board -- the forward projection ladder made TRUSTWORTHY by the N/M honesty
// (how much of the open book even has a maintained close date) shown next to the Won actuals. Pure
// presentation over the canonical showcase payload (officeProjection + per-rep bands + weeklyTrend).

function Board({ data }: { data: MondayShowcaseData }) {
  // Carry the current query (esp. ?officeId, which the api client turns into the x-office-id header) into
  // the At-Risk link, so the watchlist loads the SAME office whose forecast produced this M − N count.
  const { search } = useLocation();
  const ladder = data.officeProjection;
  const { n, m } = ladder.coverage;
  const blind = Math.max(0, m - n);
  const pctForecastable = m > 0 ? Math.round((n / m) * 100) : 0;
  const projectedValue = ladder.bands.reduce((s, b) => s + b.value, 0);
  const wonTrend = data.weeklyTrend.map((w) => w.won);
  const spikeIndex = data.weeklyTrend.findIndex((w) => w.spikeExcluded);
  const reps = [...data.reps]
    .map((r) => ({ ...r, projected: r.projection.bands.reduce((s, b) => s + b.count, 0), projectedValue: r.projection.bands.reduce((s, b) => s + b.value, 0) }))
    .filter((r) => r.projected > 0 || r.projection.coverage.m > 0)
    .sort((a, b) => b.projectedValue - a.projectedValue);

  return (
    <div className="space-y-5">
      {/* Confidence header: how much of the open book is forecastable */}
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50 to-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Forecastable pipeline</div>
            <div className="mt-1 text-4xl font-extrabold tabular-nums text-indigo-700">{usd(projectedValue)}</div>
            <div className="text-sm text-slate-500">across {int(ladder.bands.reduce((s, b) => s + b.count, 0))} future-dated open deals</div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums text-slate-800">{pctForecastable}%</div>
            <div className="text-xs text-slate-500">of open deals have a maintained close date</div>
          </div>
        </div>
        {/* coverage bar: forecastable (N) vs blind (M − N) */}
        <div className="mt-4">
          {/* With no open deals (m === 0) leave the track neutral -- an empty book is not "100% at-risk". */}
          <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
            <div className="bg-indigo-500" style={{ width: `${m > 0 ? pctForecastable : 0}%` }} title={`${n} forecastable`} />
            <div className="bg-rose-400" style={{ width: `${m > 0 ? 100 - pctForecastable : 0}%` }} title={`${blind} at-risk / undated`} />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs">
            <span className="text-indigo-700">{int(n)} forecastable</span>
            <span className="font-medium text-rose-600">
              {int(blind)} blind spots —{" "}
              <Link to={{ pathname: "/reports/at-risk", search }} className="inline-flex items-center gap-1 underline decoration-rose-300 underline-offset-2 hover:decoration-rose-600">
                <ShieldAlert className="h-3 w-3" /> see the At-Risk watchlist
              </Link>
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">{ladder.coverageCaption}</p>
        </div>
      </div>

      {/* The ladder: 4 horizon bands, drillable */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ladder.bands.map((b) => (
          <DrillNumber key={b.band} request={{ metric: "projection", band: b.band, title: `Projected ${PROJECTION_BAND_LABEL[b.band]} — office` }} className="block text-left">
            <div className="relative h-full overflow-hidden rounded-xl border border-slate-200 bg-white p-4">
              <span className={`absolute inset-y-0 left-0 w-1 ${BAND_BAR[b.band]}`} />
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${BAND_BAR[b.band]}`} />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{PROJECTION_BAND_LABEL[b.band]}</span>
              </div>
              <div className="mt-1 text-2xl font-extrabold tabular-nums text-slate-800">{usd(b.value)}</div>
              <div className="text-xs tabular-nums text-slate-400">{int(b.count)} deals</div>
            </div>
          </DrillNumber>
        ))}
      </div>

      {/* Actuals vs forecast: the 8-week Won trend (what actually closed) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">Won — last 8 weeks (actuals)</span>
          <span className="text-xs text-slate-400">the forecast above is what's coming; this is what closed</span>
        </div>
        <Sparkline values={wonTrend} spikeIndex={spikeIndex < 0 ? undefined : spikeIndex} barClass="bg-emerald-500" highlightLast height={64} />
        <div className="mt-1 flex justify-between text-[9px] tabular-nums text-slate-400">
          {data.weeklyTrend.map((w) => (
            <span key={w.weekStart}>{w.weekStart.slice(5)}</span>
          ))}
        </div>
      </div>

      {/* Per-rep contribution to the forecast */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 bg-[#f7f8fb] text-[11px] font-black uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2.5 text-left">Rep</th>
              <th className="px-3 py-2.5 text-right">Projected $</th>
              <th className="px-3 py-2.5 text-right">Projected #</th>
              <th className="px-3 py-2.5 text-right">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r.repId ?? "unassigned"} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                <td className="px-3 py-2.5 font-medium text-slate-700">{r.repName}</td>
                <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-indigo-700">{usd(r.projectedValue)}</td>
                <td className="px-3 py-2.5 text-right">
                  <DrillNumber request={{ metric: "projection", repId: r.repId, title: `${r.repName} — Projected (all)` }} className={`tabular-nums text-slate-700 ${DRILL_UNDERLINE} px-0.5`}>
                    {int(r.projected)}
                  </DrillNumber>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                  {int(r.projection.coverage.n)} / {int(r.projection.coverage.m)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ForecastConfidencePage() {
  const [mode, setMode] = useState<WeekMode>(DEFAULT_WEEK_MODE);
  const [evidence, setEvidence] = useState<EvidenceRequest | null>(null);
  const { data, loading, error } = useMondayShowcase(mode);

  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Reports · Forecast</p>
        <h1 className="text-2xl font-bold">Forecast Confidence Board</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          The forward projection ladder, made trustworthy: how much of the open book even has a maintained close
          date (the rest are blind spots), shown next to what actually closed. Every figure drills to its deals.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-4">
          <div className="inline-flex overflow-hidden rounded-lg border">
            {(["to_date", "completed"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 text-sm ${mode === m ? "bg-foreground text-background" : "bg-white text-muted-foreground"}`}>
                {m === "to_date" ? "Week-to-date" : "Last full week"}
              </button>
            ))}
          </div>
          <DrillProvider open={setEvidence}>
            <Board data={data} />
          </DrillProvider>
        </div>
      ) : (
        <div className="rounded-lg border bg-gray-50 p-6 text-sm text-muted-foreground">No forecast data for this period.</div>
      )}

      <EvidenceDrawer request={evidence} mode={mode} onClose={() => setEvidence(null)} />
    </div>
  );
}
