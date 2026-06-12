import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useDailySummary } from "@/hooks/use-daily-summary";

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

export function DailySummaryPage() {
  useParams(); // :date is display sugar; the token is authoritative for which snapshot loads.
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { data, loading, error } = useDailySummary(token);

  const maxActions = useMemo(() => (data ? data.leaderboard.reduce((mx, r) => Math.max(mx, r.actions), 0) : 0), [data]);

  if (loading) return <Centered>Loading…</Centered>;
  if (error || !data) return <Centered>{error ?? "Not found."}</Centered>;

  const h = data.headline;
  const wonCount = data.majorMoves.filter((m) => m.kind === "won").length;
  const advancedCount = data.majorMoves.filter((m) => m.kind === "advanced").length;

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-2xl space-y-6 px-4">
        {/* Header */}
        <div className="overflow-hidden rounded-2xl bg-slate-900 shadow-sm">
          <div className="h-1.5 w-full bg-gradient-to-r from-[#CC0000] to-[#790000]" />
          <div className="flex items-baseline justify-between px-6 py-4">
            <span className="text-lg font-black uppercase tracking-wide text-white">T Rock · Daily Pulse</span>
            <span className="text-xs font-semibold text-slate-300">{prettyDate(data.date)} · {data.asOfLabel}</span>
          </div>
        </div>

        {/* Headline strip */}
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Active" value={`${num(h.activeReps)}/${num(h.totalReps)}`} />
          <Stat label="Actions" value={num(h.totalActions)} />
          <Stat label="Biggest mover" value={h.biggestMover ? h.biggestMover.name : "—"} accent
                sub={h.biggestMover ? `+${num(h.biggestMover.actions)}` : undefined} />
        </div>

        {/* Leaderboard */}
        <Card title="Leaderboard">
          {data.leaderboard.some((r) => r.actions > 0) ? (
            <div className="space-y-2">
              {data.leaderboard.filter((r) => r.actions > 0).map((r) => (
                <div key={r.rank} className="flex items-center gap-3">
                  <span className={`w-5 text-sm font-bold tabular-nums ${r.rank === 1 ? "text-[#CC0000]" : "text-slate-300"}`}>{r.rank}</span>
                  <span className="w-32 shrink-0 truncate text-sm font-medium text-slate-800">{r.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full" style={{ width: `${maxActions > 0 ? Math.max(4, Math.round((r.actions / maxActions) * 100)) : 0}%`, background: r.rank === 1 ? RED : "#cbd5e1" }} />
                  </div>
                  <span className="w-12 text-right text-sm font-bold tabular-nums text-slate-700">{num(r.actions)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Quiet>Quiet day — no rep activity yet.</Quiet>
          )}
        </Card>

        {/* Major moves */}
        <Card title="Major moves today">
          {data.majorMoves.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{wonCount} won · {advancedCount} advanced</div>
              {data.majorMoves.map((m, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-slate-800">
                  <span className={m.kind === "won" ? "font-bold text-[#CC0000]" : "text-slate-400"}>{m.kind === "won" ? "★ Won" : "→"}</span>
                  <span className="truncate">{m.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <Quiet>Quiet day — no major moves.</Quiet>
          )}
        </Card>

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
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}
function Quiet({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-sm text-slate-400">{children}</div>;
}
