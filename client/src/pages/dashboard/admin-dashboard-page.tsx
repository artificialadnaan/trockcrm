import { buildAdminOperationsTiles } from "@/lib/admin-dashboard-summary";
import { useAdminDashboardSummary } from "@/hooks/use-admin-dashboard-summary";
import { AdminOperationsWorkspace } from "@/components/dashboard/admin-operations-workspace";

export function AdminDashboardPage() {
  const { data, loading, error } = useAdminDashboardSummary();
  const tiles = data ? buildAdminOperationsTiles(data) : [];

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Operations Console</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          Admin home is now organized around operational risk and queue health first, with sales context kept secondary.
        </p>
      </div>
      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {loading && !data ? (
        <section className="space-y-4" aria-label="Operations workspace">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Needs attention now</h2>
            <p className="text-sm text-slate-500">Operational queues and system signals that need review first.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="h-4 w-24 animate-pulse rounded bg-slate-100" />
                <div className="mt-4 h-8 w-12 animate-pulse rounded bg-slate-100" />
                <div className="mt-2 h-3 w-28 animate-pulse rounded bg-slate-100" />
              </div>
            ))}
          </div>
        </section>
      ) : (
        <AdminOperationsWorkspace tiles={tiles} />
      )}
    </div>
  );
}
