import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useDailySummary, type LeaderRow, type RepBreakdown } from "@/hooks/use-daily-summary";

const RED = "#CC0000";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Format the CT-resolved date string — no tz conversion (see platform-usage-page for the rationale).
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}
const num = (n: number | null | undefined) => (Number.isFinite(n) ? Number(n).toLocaleString("en-US") : "—");
const usdFull = (n: number | null | undefined) => (Number.isFinite(n) ? `$${Math.round(Number(n)).toLocaleString("en-US")}` : "$0");
// "minutes where present, — where absent, never 0m" — guarded so 0/negative also render "—".
const minutesLabel = (m: number | null) =>
  m == null || !Number.isFinite(m) || m <= 0 ? "—" : `${num(m)}m`;
function pluralizeActivity(type: string): string {
  const known: Record<string, string> = {
    email: "emails", note: "notes", call: "calls", meeting: "meetings", voicemail: "voicemails",
    text: "texts", sms: "texts",
  };
  return known[type] ?? `${type.replace(/_/g, " ")}s`;
}
// Team time-spent: 0 -> "—"; < 1h -> minutes; otherwise hours to one decimal.
function hoursLabel(totalMinutes: number | null | undefined): string {
  if (!Number.isFinite(totalMinutes) || Number(totalMinutes) <= 0) return "—";
  const m = Number(totalMinutes);
  return m < 60 ? `${num(m)}m` : `${(m / 60).toFixed(1)}h`;
}
function hourLabel(h: number): string {
  const ampm = h < 12 ? "a" : "p";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

export function DailySummaryPage() {
  useParams(); // :date is display sugar; the token is authoritative for which snapshot loads.
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { data, loading, error } = useDailySummary(token);

  const wonTotal = useMemo(
    () => (data ? data.wonToday.reduce((s, d) => s + (Number.isFinite(d.value) ? d.value : 0), 0) : 0),
    [data]
  );
  const maxHourReps = useMemo(() => (data ? data.hourly.reduce((mx, h) => Math.max(mx, h.reps), 0) : 0), [data]);

  if (loading) return <Centered>Loading…</Centered>;
  if (error || !data) return <Centered>{error ?? "Not found."}</Centered>;

  const h = data.headline;
  const workers = data.leaderboard.filter((r) => r.actions > 0);

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-3xl space-y-6 px-4">
        {/* Header */}
        <div className="overflow-hidden rounded-2xl bg-slate-900 shadow-sm">
          <div className="h-1.5 w-full bg-gradient-to-r from-[#CC0000] to-[#790000]" />
          <div className="flex items-baseline justify-between px-6 py-4">
            <span className="text-lg font-black uppercase tracking-wide text-white">T Rock · Daily Pulse</span>
            <span className="text-xs font-semibold text-slate-300">{prettyDate(data.date)} · {data.asOfLabel}</span>
          </div>
        </div>

        {/* Headline strip — activity (reps / time / actions) + the biggest mover */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Active" value={`${num(h.activeReps)}/${num(h.totalReps)}`} />
          <Stat label="Time" value={hoursLabel(h.totalActiveMinutes)} sub={`${num(h.totalSessions)} sessions`} />
          <Stat label="Actions" value={num(h.totalActions)} />
          <Stat label="Biggest mover" value={h.biggestMover ? h.biggestMover.name : "—"} accent
                sub={h.biggestMover ? `+${num(h.biggestMover.actions)}` : undefined} />
        </div>

        {/* Won today — full, uncapped */}
        <Card title="Won today" right={data.wonToday.length ? `${data.wonToday.length} · ${usdFull(wonTotal)}` : undefined}>
          {data.wonToday.length ? (
            <table className="w-full text-sm">
              <tbody>
                {data.wonToday.map((d, i) => (
                  <tr key={i} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 pr-3 text-slate-800"><span className="text-emerald-600">●</span> {d.dealName}</td>
                    <td className="py-1.5 px-3 text-slate-500">{d.repName}</td>
                    <td className="py-1.5 text-right font-bold tabular-nums text-slate-800 whitespace-nowrap">{usdFull(d.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Quiet>No deals won today.</Quiet>
          )}
        </Card>

        {/* Advanced today — full, uncapped */}
        <Card title="Advanced today" right={data.advancedToday.length ? `${data.advancedToday.length} ${data.advancedToday.length === 1 ? "move" : "moves"}` : undefined}>
          {data.advancedToday.length ? (
            <table className="w-full text-sm">
              <tbody>
                {data.advancedToday.map((m, i) => (
                  <tr key={i} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 pr-3 text-slate-800 whitespace-nowrap">▸ {m.dealName}</td>
                    <td className="py-1.5 px-3 text-slate-500">{m.fromStage ?? "—"} → {m.toStage ?? "—"}</td>
                    <td className="py-1.5 text-right text-slate-500">{m.repName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Quiet>No stage advances today.</Quiet>
          )}
        </Card>

        {/* Who moved it — per-rep, uncapped, breakdown columns */}
        <Card title="Who moved it">
          {workers.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="py-1 pr-2 text-left font-semibold">#</th>
                    <th className="py-1 px-2 text-left font-semibold">Rep</th>
                    <th className="py-1 px-2 text-right font-semibold">Time</th>
                    <th className="py-1 px-2 text-right font-semibold">Actions</th>
                    <th className="py-1 pl-2 text-left font-semibold">Breakdown</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((r) => (
                    <tr key={r.rank} className="border-b border-slate-50 last:border-0">
                      <td className={`py-1.5 pr-2 font-bold tabular-nums ${r.rank === 1 ? "text-[#CC0000]" : "text-slate-300"}`}>{r.rank}</td>
                      <td className="py-1.5 px-2 font-medium text-slate-800">{r.name}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-slate-600">{minutesLabel(r.activeMinutes)}</td>
                      <td className="py-1.5 px-2 text-right font-bold tabular-nums text-slate-800">{num(r.actions)}</td>
                      <td className="py-1.5 pl-2 text-slate-500">{breakdownLine(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Quiet>Quiet day — no rep activity yet.</Quiet>
          )}
        </Card>

        {/* Activity by hour — the one honest time visual (browser-session reps only) */}
        {data.hourly.length ? (
          <Card title="Activity by hour">
            <div className="flex items-end gap-1.5" style={{ height: 96 }}>
              {data.hourly.map((slot) => (
                <div key={slot.hour} className="flex flex-1 flex-col items-center justify-end">
                  <div
                    className="w-full rounded-t"
                    style={{ height: `${maxHourReps > 0 ? Math.max(6, Math.round((slot.reps / maxHourReps) * 80)) : 0}px`, background: RED, opacity: 0.85 }}
                    title={`${slot.reps} rep(s) active`}
                  />
                  <span className="mt-1 text-[10px] tabular-nums text-slate-400">{hourLabel(slot.hour)}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-400">Reps with an open browser session, by Central hour. Activity via API/import isn’t in this curve.</p>
          </Card>
        ) : null}

        {/* Team health */}
        <Card title="Team health">
          <div className="flex items-baseline gap-4 text-sm">
            <span className="font-bold text-emerald-700">{num(data.teamHealth.active)} active</span>
            <span className="font-bold text-slate-500">{num(data.teamHealth.quiet)} quiet</span>
          </div>
          {data.teamHealth.quietNames.length > 0 ? (
            <div className="mt-1 truncate text-xs text-slate-400">Quiet: {data.teamHealth.quietNames.join(", ")}</div>
          ) : null}
        </Card>

        <p className="px-1 text-xs text-slate-400">
          Snapshot {data.asOfLabel} — a mid-day check-in, not a complete daily total.
        </p>
      </div>
    </div>
  );
}

/** Non-zero buckets only, highest-signal first — the breakdown IS the value. All activity types included. */
function breakdownLine(r: LeaderRow): string {
  const b: RepBreakdown = r.breakdown;
  const acts = Object.entries(b.activities ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))
    .map(([type, n]) => [n, pluralizeActivity(type)] as [number, string]);
  const parts: [number, string][] = [
    [b.created, "created"],
    [b.stageMoves, "moves"],
    ...acts,
    [b.edits, "edits"],
    [b.uploads, "uploads"],
    [b.reports, "reports"],
  ];
  const nz = parts.filter(([n]) => n > 0);
  return nz.length ? nz.map(([n, label]) => `${num(n)} ${label}`).join(", ") : "—";
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-sm text-slate-500">{children}</div>;
}
function Stat({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
      <div className={`truncate text-2xl font-black tabular-nums ${accent ? "text-[#CC0000]" : "text-slate-900"}`}>{value}</div>
      {sub ? <div className="text-xs font-bold text-slate-400">{sub}</div> : null}
      <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}
function Card({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
        {right ? <div className="text-sm font-bold tabular-nums text-slate-700">{right}</div> : null}
      </div>
      {children}
    </div>
  );
}
function Quiet({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-sm text-slate-400">{children}</div>;
}
