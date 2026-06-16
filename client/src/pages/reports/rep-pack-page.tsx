import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRepPack } from "@/hooks/use-reports";
import { PROJECTION_BAND_LABEL, type EvidenceRequest, type RepShowcaseRow, type ShowcaseWeek } from "./monday-showcase/types";
import { DrillProvider, DrillNumber, EvidenceDrawer, usd, int, BAND_BAR, ACCENT, DRILL_UNDERLINE, type AccentKey } from "./evidence-kit";
import { DEFAULT_WEEK_MODE, type WeekMode } from "./week-mode";

// B·1 Rep 1:1 Pack -- one rep across the board, reconciling to the office numbers (their slice is lifted
// from the canonical showcase payload), plus their own 8-week trend. Every figure drills to the records.

const LANES: Array<{ key: "estimating" | "sent" | "won"; label: string; accent: AccentKey }> = [
  { key: "estimating", label: "Estimating", accent: "estimating" },
  { key: "sent", label: "Sent", accent: "sent" },
  { key: "won", label: "Won", accent: "won" },
];

function RepTrend({ trend, mode }: { trend: ShowcaseWeek[]; mode: WeekMode }) {
  const weeks = trend.slice(-8);
  const lastIdx = weeks.length - 1;
  const lastInProgress = mode === "to_date";
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {LANES.map((lane) => {
        const series = weeks.map((w) => w[lane.key]);
        const max = Math.max(1, ...series);
        const accent = ACCENT[lane.accent];
        return (
          <div key={lane.key} className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3">
            <span className={`absolute inset-y-0 left-0 w-1 ${accent.bar}`} />
            <div className="mb-1 flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${accent.bar}`} />
              <span className="text-xs font-semibold text-slate-700">{lane.label}</span>
            </div>
            <div className="flex h-14 items-end gap-1">
              {series.map((v, i) => {
                const spike = weeks[i]?.spikeExcluded;
                const isLast = i === lastIdx && lastInProgress;
                return (
                  <div key={i} className="flex flex-1 flex-col items-center gap-0.5">
                    <div
                      title={spike ? `${v} (spike — excluded)` : isLast ? `${v} (in progress)` : String(v)}
                      className={`w-full rounded-t ${spike ? "bg-amber-400" : isLast ? `${accent.bar} opacity-50` : accent.bar} ${i === lastIdx ? "ring-2 ring-slate-300 ring-offset-1" : ""}`}
                      style={{ height: `${Math.max(3, (v / max) * 48)}px` }}
                    />
                    <span className="text-[8px] tabular-nums text-slate-400">{weeks[i]?.weekStart.slice(5)}</span>
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

function HeadlineTile({ label, accent, count, value, request }: { label: string; accent: AccentKey; count: number; value?: number; request: EvidenceRequest }) {
  const a = ACCENT[accent];
  return (
    <DrillNumber request={request} className="block text-left">
      <div className={`relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-b to-white p-4 ${a.grad}`}>
        <span className={`absolute inset-y-0 left-0 w-1 ${a.bar}`} />
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <div className={`mt-1 text-3xl font-extrabold tabular-nums ${a.text}`}>{int(count)}</div>
        {value != null && <div className="text-xs tabular-nums text-slate-400">{usd(value)}</div>}
      </div>
    </DrillNumber>
  );
}

function Pack({ rep, trend, mode }: { rep: RepShowcaseRow; trend: ShowcaseWeek[]; mode: WeekMode }) {
  const projected = rep.projection.bands.reduce((s, b) => s + b.count, 0);
  const leadsTotal = rep.leadStatus.reduce((s, l) => s + l.count, 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HeadlineTile label="Closed" accent="won" count={rep.closed.count} value={rep.closed.value.amount} request={{ metric: "won", repId: rep.repId, title: `${rep.repName} — Won` }} />
        <HeadlineTile label="Sent" accent="sent" count={rep.sentThisWeek.count} value={rep.sentThisWeek.value.amount} request={{ metric: "sent", repId: rep.repId, title: `${rep.repName} — Sent` }} />
        <HeadlineTile label="Projected (open)" accent="estimating" count={projected} request={{ metric: "projection", repId: rep.repId, title: `${rep.repName} — Projected (all)` }} />
        <HeadlineTile label="Active leads" accent="leads" count={leadsTotal} request={{ metric: "leads", repId: rep.repId, title: `${rep.repName} — Active leads` }} />
      </div>

      <div>
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Last 8 weeks</div>
        <RepTrend trend={trend} mode={mode} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">Projection ladder</span>
          <span className="text-[11px] text-slate-400">{rep.projection.coverageCaption}</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {rep.projection.bands.map((b) => (
            <DrillNumber key={b.band} request={{ metric: "projection", repId: rep.repId, band: b.band, title: `${rep.repName} — Projected ${PROJECTION_BAND_LABEL[b.band]}` }} className="block">
              <div className="rounded-lg border border-slate-200 p-2 text-center">
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
      </div>

      {rep.leadStatus.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-sm font-semibold text-slate-700">Active leads by stage</div>
          <div className="flex flex-wrap gap-2 text-xs">
            {rep.leadStatus.map((ls) => (
              <DrillNumber key={ls.stageLabel} request={{ metric: "leads", repId: rep.repId, leadStage: ls.stageLabel, title: `${rep.repName} — ${ls.stageLabel} leads` }} className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700 ring-1 ring-amber-200">
                {ls.stageLabel}: {int(ls.count)}
              </DrillNumber>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function RepPackPage() {
  const [mode, setMode] = useState<WeekMode>(DEFAULT_WEEK_MODE);
  const [repId, setRepId] = useState<string | undefined>(undefined);
  const [evidence, setEvidence] = useState<EvidenceRequest | null>(null);
  const { data, loading, error } = useRepPack(repId, mode);
  // The rep actually shown: the user's pick when it's a known option, else the server-resolved rep. Build
  // the <select> so the shown rep is ALWAYS one of the options — including the typed-but-currently-
  // unreachable null/Unassigned bucket the server could in principle resolve to — so the control can never
  // render a blank value with no matching <option>. A sentinel encodes the null bucket as an option value.
  const UNASSIGNED = "__unassigned__";
  const selVal = (id: string | null) => id ?? UNASSIGNED;
  const shownRep = data
    ? ((repId ? data.allReps.find((r) => r.repId === repId) : undefined) ??
      { repId: data.rep.repId, repName: data.rep.repName })
    : null;
  const repOptions =
    data && shownRep
      ? data.allReps.some((r) => r.repId === shownRep.repId)
        ? data.allReps
        : [{ repId: shownRep.repId, repName: shownRep.repName }, ...data.allReps]
      : [];

  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Reports · Sales management</p>
        <h1 className="text-2xl font-bold">Rep 1:1 Pack</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          One rep across the board — their Won/Sent/Estimating, projection ladder and active leads (reconciling
          to the office numbers) plus their own 8-week trend. Every figure drills to its records.
        </p>
      </div>

      {!data && loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : !data && error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-4">
          {/* Controls stay mounted across a rep/mode switch; the body just dims while the next load lands. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-500">Rep</span>
              <select
                value={shownRep ? selVal(shownRep.repId) : ""}
                onChange={(e) => setRepId(e.target.value === UNASSIGNED ? undefined : e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-medium"
              >
                {repOptions.map((r) => (
                  <option key={selVal(r.repId)} value={selVal(r.repId)}>{r.repName}</option>
                ))}
              </select>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            <div className="flex items-center gap-3">
              <div className="inline-flex overflow-hidden rounded-lg border">
                {(["to_date", "completed"] as const).map((m) => (
                  <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 text-sm ${mode === m ? "bg-foreground text-background" : "bg-white text-muted-foreground"}`}>
                    {m === "to_date" ? "Week-to-date" : "Last full week"}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">{data.period.label}</span>
            </div>
          </div>
          <div className={loading ? "pointer-events-none opacity-50 transition-opacity" : "transition-opacity"}>
            <DrillProvider open={setEvidence}>
              <Pack rep={data.rep} trend={data.trend} mode={mode} />
            </DrillProvider>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-gray-50 p-6 text-sm text-muted-foreground">No reps with activity this period.</div>
      )}

      <EvidenceDrawer request={evidence} mode={mode} onClose={() => setEvidence(null)} />
    </div>
  );
}
