import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { usePlatformUsageReport, formatActiveTime, type PlatformUsageRow } from "@/hooks/use-platform-usage-report";

export function PlatformUsagePage() {
  const [grain, setGrain] = useState<"day" | "week">("week");
  const [anchorDate, setAnchorDate] = useState<string>("");
  const { data, loading, error } = usePlatformUsageReport({ grain, date: anchorDate || undefined });

  const rows = useMemo<PlatformUsageRow[]>(() => {
    if (!data) return [];
    // Time sort: reps with no active time ("—") sort last, never as zero.
    return [...data.leaderboard].sort((a, b) => {
      const at = a.usage.activeSeconds, bt = b.usage.activeSeconds;
      if (at === 0 && bt === 0) return b.usage.actionCount - a.usage.actionCount;
      if (at === 0) return 1;
      if (bt === 0) return -1;
      return bt - at;
    });
  }, [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Performance"
        title="Platform Usage"
        description="Active time, actions, and views per rep — daily and weekly."
      />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setGrain("day")} aria-pressed={grain === "day"} className={grain === "day" ? "font-bold" : ""}>Daily</button>
        <button type="button" onClick={() => setGrain("week")} aria-pressed={grain === "week"} className={grain === "week" ? "font-bold" : ""}>Weekly</button>
        <input
          type="date"
          value={anchorDate}
          onChange={(e) => setAnchorDate(e.target.value)}
          aria-label="Report date"
          className="rounded border px-2 py-1 text-sm"
        />
        <button type="button" onClick={() => setAnchorDate("")} className="text-sm">Today</button>
      </div>

      {loading ? <p>Loading…</p> : null}
      {error ? <p className="text-brand-red">{error}</p> : null}

      {data ? (
        <>
          <div className="grid grid-cols-3 gap-4">
            <SummaryCell label="Active time" value={formatActiveTime(data.summary.activeSeconds)} />
            <SummaryCell label="Actions" value={String(data.summary.actionCount)} />
            <SummaryCell label="Reps active" value={`${data.summary.activeReps}/${data.summary.totalReps}`} />
          </div>

          <table className="w-full text-left text-sm">
            <thead>
              <tr><th>Rep</th><th>Active time</th><th>Actions</th><th>Sessions</th><th>Views</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rep.id}>
                  <td>{r.rep.displayName}</td>
                  <td>{formatActiveTime(r.usage.activeSeconds)}</td>
                  <td>{r.usage.actionCount}</td>
                  <td>{r.usage.sessionCount}</td>
                  <td>{r.usage.viewCount ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-xs text-slate-500">
            Note: impersonated stage changes, logged activities, and uploads attribute to the impersonated rep
            (time and views are excluded). Pre-launch days show "—" for time and views.
          </p>
        </>
      ) : null}
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
