import { ArrowRight, BarChart3, ClipboardList, Loader2, RefreshCw } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button, Panel } from "../components/ui";
import { useAdminProgressByUser, useAdminProgressSummary, useMe } from "../hooks/use-cleanup";

function canUseAdminTools(role?: string) {
  return role === "admin" || role === "director";
}

function formatDate(value?: string | null) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-md border border-stone-300 bg-stone-50 p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-2 text-3xl font-black tabular-nums text-stone-950">{value}</p>
      {detail ? <p className="mt-1 text-sm text-stone-600">{detail}</p> : null}
    </div>
  );
}

function ProgressStack({ completed, skipped, remaining }: { completed: number; skipped: number; remaining: number }) {
  return (
    <div className="flex h-4 overflow-hidden rounded bg-stone-200">
      <div className="bg-emerald-600" style={{ width: `${completed}%` }} />
      <div className="bg-amber-500" style={{ width: `${skipped}%` }} />
      <div className="bg-stone-400" style={{ width: `${remaining}%` }} />
    </div>
  );
}

export function AdminProgressPage() {
  const { data: user, isLoading: userLoading } = useMe();
  const adminEnabled = canUseAdminTools(user?.role);
  const summary = useAdminProgressSummary(adminEnabled);
  const byUser = useAdminProgressByUser(adminEnabled);
  const navigate = useNavigate();

  if (userLoading) {
    return (
      <main className="grid min-h-[80vh] place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-red-700" />
      </main>
    );
  }
  if (!adminEnabled) return <Navigate to="/cleanup" replace />;

  const data = summary.data;
  const loading = summary.isLoading || byUser.isLoading;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-col gap-4 border-b border-stone-300 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-red-800">Admin</p>
          <h1 className="mt-2 text-3xl font-black text-stone-950">Cleanup progress</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">Live cleanup status by rep and record type. Lowest completion rates are listed first.</p>
        </div>
        <Button variant="secondary" onClick={() => { summary.refetch(); byUser.refetch(); }}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="mt-8 flex items-center gap-2 text-sm text-stone-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading progress
        </div>
      ) : data ? (
        <>
          <section className="mt-6 grid gap-3 md:grid-cols-4">
            <Metric label="Total records" value={data.total} />
            <Metric label="Completed" value={data.completed} detail={`${data.percentCompleted}% of total`} />
            <Metric label="Skipped" value={data.skipped} detail={`${data.percentSkipped}% of total`} />
            <Metric label="Remaining" value={data.remaining} detail={`${data.percentRemaining}% of total`} />
          </section>

          <Panel className="mt-5 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-black text-stone-950">Overall progress</h2>
                <p className="text-sm text-stone-600">{data.percentDone}% handled across all cleanup records</p>
              </div>
              <BarChart3 className="h-5 w-5 text-red-800" />
            </div>
            <div className="mt-4">
              <ProgressStack completed={data.percentCompleted} skipped={data.percentSkipped} remaining={data.percentRemaining} />
              <div className="mt-2 flex flex-wrap gap-4 text-xs font-semibold text-stone-600">
                <span>Completed</span>
                <span>Skipped</span>
                <span>Remaining</span>
              </div>
            </div>
          </Panel>

          <section className="mt-6 grid gap-6 xl:grid-cols-[1fr_420px]">
            <Panel className="overflow-hidden">
              <div className="border-b border-stone-300 bg-stone-200 px-4 py-3">
                <h2 className="font-black text-stone-950">Per-rep breakdown</h2>
              </div>
              <div className="hidden grid-cols-[1fr_80px_100px_80px_100px_80px_170px_56px] gap-3 border-b border-stone-300 px-4 py-3 text-xs font-bold uppercase tracking-wide text-stone-600 lg:grid">
                <span>Rep</span>
                <span>Total</span>
                <span>Completed</span>
                <span>Skipped</span>
                <span>Remaining</span>
                <span>% Done</span>
                <span>Last Activity</span>
                <span />
              </div>
              {byUser.data?.map((row) => (
                <button
                  key={row.user.id}
                  className="grid w-full gap-2 border-b border-stone-200 px-4 py-4 text-left last:border-0 hover:bg-stone-100 lg:grid-cols-[1fr_80px_100px_80px_100px_80px_170px_56px] lg:items-center"
                  onClick={() => navigate(`/admin/progress/${row.user.id}`)}
                >
                  <span>
                    <span className="block font-bold text-stone-950">{row.user.displayName}</span>
                    <span className="block text-sm text-stone-600">{row.user.email}</span>
                  </span>
                  <span className="text-sm tabular-nums text-stone-700">{row.total}</span>
                  <span className="text-sm tabular-nums text-stone-700">{row.completed}</span>
                  <span className="text-sm tabular-nums text-stone-700">{row.skipped}</span>
                  <span className="text-sm tabular-nums text-stone-700">{row.remaining}</span>
                  <span className="font-black tabular-nums text-stone-950">{row.percentDone}%</span>
                  <span className="text-sm text-stone-600">{formatDate(row.lastActivityAt)}</span>
                  <ArrowRight className="h-4 w-4 text-stone-500" />
                </button>
              ))}
            </Panel>

            <Panel className="p-5">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-red-800" />
                <h2 className="font-black text-stone-950">By record type</h2>
              </div>
              <div className="mt-4 space-y-4">
                {data.byType.map((type) => (
                  <div key={type.type}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-bold capitalize text-stone-950">{type.type}</span>
                      <span className="tabular-nums text-stone-600">{type.percentDone}% done</span>
                    </div>
                    <div className="mt-2 h-3 overflow-hidden rounded bg-stone-200">
                      <div className="h-full bg-red-700" style={{ width: `${type.percentDone}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-stone-600">{type.completed} completed, {type.skipped} skipped, {type.remaining} remaining</p>
                  </div>
                ))}
              </div>
            </Panel>
          </section>
        </>
      ) : null}
    </main>
  );
}
