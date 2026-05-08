import { CheckCircle2, Loader2, Printer, TrendingUp } from "lucide-react";
import { Navigate } from "react-router-dom";
import { Button, Panel } from "../components/ui";
import { useCleanupSummaryReport, useMe } from "../hooks/use-cleanup";

function canUseAdminTools(role?: string) {
  return role === "admin" || role === "director";
}

function formatDate(value?: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function CountTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns: string[] }) {
  return (
    <table className="min-w-full text-left text-sm">
      <thead className="text-xs font-bold uppercase tracking-wide text-stone-500">
        <tr>{columns.map((column) => <th key={column} className="border-b border-stone-300 px-3 py-2">{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-b border-stone-200 last:border-0">
            {columns.map((column) => <td key={column} className="px-3 py-2 text-stone-800">{String(row[column] ?? "")}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function TimelineBars({ rows }: { rows: Array<{ hour: string; actions: number; completed: number; skipped: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.actions));
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const width = Math.max(3, Math.round((row.actions / max) * 100));
        return (
          <div key={row.hour} className="grid grid-cols-[92px_minmax(0,1fr)_76px] items-center gap-3 text-xs">
            <span className="text-stone-600">{formatDate(row.hour).replace(/, \d{4}/, "")}</span>
            <div className="h-3 rounded bg-stone-200">
              <div className="h-3 rounded bg-red-700" style={{ width: `${width}%` }} />
            </div>
            <span className="text-right font-semibold tabular-nums text-stone-800">{row.actions} actions</span>
          </div>
        );
      })}
    </div>
  );
}

export function CleanupSummaryReportPage() {
  const { data: user, isLoading: userLoading } = useMe();
  const adminEnabled = canUseAdminTools(user?.role);
  const report = useCleanupSummaryReport(adminEnabled);

  if (userLoading) {
    return (
      <main className="grid min-h-[80vh] place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-red-700" />
      </main>
    );
  }
  if (!adminEnabled) return <Navigate to="/cleanup" replace />;

  const data = report.data;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 print:max-w-none print:bg-white print:px-0 sm:px-6 lg:py-8">
      <style>{`
        @media print {
          header, button { display: none !important; }
          section { break-inside: avoid; }
          body { background: white !important; }
        }
      `}</style>
      {report.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-stone-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading cleanup report
        </div>
      ) : data ? (
        <>
          <div className="flex flex-col gap-4 border-b border-stone-300 pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-bold uppercase tracking-wide text-red-800">Leadership report</p>
              <h1 className="mt-2 text-3xl font-black text-stone-950">Cleanup summary</h1>
              <p className="mt-2 text-sm text-stone-600">Generated {formatDate(data.generatedAt)}</p>
            </div>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="h-4 w-4" />
              Print
            </Button>
          </div>

          <section className="mt-6 grid gap-3 md:grid-cols-4">
            {[
              ["Total", data.overall.total],
              ["Completed", data.overall.completed],
              ["Skipped", data.overall.skipped],
              ["Remaining", data.overall.remaining],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-stone-300 bg-stone-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
                <p className="mt-2 text-3xl font-black tabular-nums text-stone-950">{value}</p>
              </div>
            ))}
          </section>

          <Panel className="mt-5 p-5">
            <div className="grid gap-4 md:grid-cols-[1fr_280px] md:items-center">
              <div>
                <h2 className="text-lg font-black text-stone-950">Cleanup timing</h2>
                <p className="mt-2 text-sm text-stone-700">First action: {formatDate(data.overall.firstActionAt)}</p>
                <p className="text-sm text-stone-700">Most recent action: {formatDate(data.overall.lastActionAt)}</p>
              </div>
              <div className="rounded-md border border-stone-300 bg-stone-100 p-4">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-stone-600">
                  <TrendingUp className="h-4 w-4 text-red-800" />
                  Current velocity
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums text-stone-950">{data.currentVelocity.completedLastHour} completed/hr</p>
                <p className="text-sm text-stone-600">{data.currentVelocity.skippedLastHour} skipped in the last hour</p>
              </div>
            </div>
          </Panel>

          <section className="mt-6 grid gap-6 lg:grid-cols-2">
            <Panel className="overflow-hidden">
              <div className="border-b border-stone-300 bg-stone-200 px-4 py-3"><h2 className="font-black">Per-rep summary</h2></div>
              <CountTable rows={data.perRep.map((row) => ({ rep: row.user.email, total: row.total, completed: row.completed, skipped: row.skipped, remaining: row.remaining, done: `${row.percentDone}%` }))} columns={["rep", "total", "completed", "skipped", "remaining", "done"]} />
            </Panel>
            <Panel className="overflow-hidden">
              <div className="border-b border-stone-300 bg-stone-200 px-4 py-3"><h2 className="font-black">Skip analysis</h2></div>
              <CountTable rows={data.skipAnalysis.byReason} columns={["reason", "count"]} />
            </Panel>
            <Panel className="overflow-hidden">
              <div className="border-b border-stone-300 bg-stone-200 px-4 py-3"><h2 className="font-black">Data quality improvement</h2></div>
              <CountTable
                rows={data.dataQuality.metrics.map((metric) => ({
                  metric: metric.label,
                  before: metric.before,
                  after: metric.after,
                  lift: `+${metric.delta}`,
                  improvement: percent(metric.percentLift),
                }))}
                columns={["metric", "before", "after", "lift", "improvement"]}
              />
            </Panel>
            <Panel className="p-5">
              <h2 className="font-black text-stone-950">Cleanup leaderboard</h2>
              <div className="mt-4 grid gap-4 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Most completed</p>
                  <ol className="mt-2 space-y-2 text-sm">
                    {data.leaderboard.mostCompleted.map((row) => (
                      <li key={row.user.id} className="flex justify-between gap-3">
                        <span className="truncate">{row.user.displayName || row.user.email}</span>
                        <span className="font-bold tabular-nums">{row.completed}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Most skipped</p>
                  <ol className="mt-2 space-y-2 text-sm">
                    {data.leaderboard.mostSkipped.map((row) => (
                      <li key={row.user.id} className="flex justify-between gap-3">
                        <span className="truncate">{row.user.displayName || row.user.email}</span>
                        <span className="font-bold tabular-nums">{row.skipped}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Not started</p>
                  <ul className="mt-2 space-y-2 text-sm">
                    {data.leaderboard.notStarted.length > 0 ? data.leaderboard.notStarted.map((row) => (
                      <li key={row.user.id} className="truncate">{row.user.displayName || row.user.email}</li>
                    )) : (
                      <li className="flex items-center gap-2 text-emerald-800">
                        <CheckCircle2 className="h-4 w-4" />
                        Everyone has started
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </Panel>
            <Panel className="p-5">
              <h2 className="font-black text-stone-950">Activity timeline</h2>
              <p className="mt-1 text-sm text-stone-600">Cleanup actions by hour over the last day.</p>
              <div className="mt-4">
                <TimelineBars rows={data.timeline} />
              </div>
            </Panel>
            <Panel className="overflow-hidden">
              <div className="border-b border-stone-300 bg-stone-200 px-4 py-3"><h2 className="font-black">Admin queue</h2></div>
              <CountTable rows={data.adminQueue} columns={["type", "count"]} />
            </Panel>
            <Panel className="overflow-hidden">
              <div className="border-b border-stone-300 bg-stone-200 px-4 py-3"><h2 className="font-black">Reassignments</h2></div>
              <CountTable rows={data.reassignments} columns={["from", "to", "count"]} />
            </Panel>
            <Panel className="overflow-hidden">
              <div className="border-b border-stone-300 bg-stone-200 px-4 py-3"><h2 className="font-black">Flagged items</h2></div>
              <CountTable rows={data.flaggedItems} columns={["type", "count"]} />
            </Panel>
          </section>

          <Panel className="mt-6 p-5">
            <h2 className="font-black text-stone-950">Audit coverage</h2>
            <p className="mt-2 text-sm text-stone-700">{data.auditCoverage.crmAuditLog}</p>
            <p className="text-sm text-stone-700">{data.auditCoverage.cleanupAuditLog}</p>
            <p className="text-sm text-stone-700">{data.auditCoverage.knownGap}</p>
          </Panel>
        </>
      ) : null}
    </main>
  );
}
