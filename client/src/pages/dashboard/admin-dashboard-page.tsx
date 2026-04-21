import { AdminOperationsWorkspace } from "@/components/dashboard/admin-operations-workspace";
import { DashboardKpiBand } from "@/components/dashboard/dashboard-kpi-band";
import { useAdminDashboardSummary } from "@/hooks/use-admin-dashboard-summary";

export function AdminDashboardPage() {
  const { summary, loading } = useAdminDashboardSummary();
  const teamSnapshot = summary.kpis.find((item) => item.label === "Team snapshot");

  if (loading) {
    return <div className="space-y-4"><div className="h-24 rounded-2xl bg-gray-100 animate-pulse" /><div className="h-64 rounded-2xl bg-gray-100 animate-pulse" /></div>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-black tracking-tight text-gray-900">Admin Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">Operational queues, system health, and workspace changes without the sales-team noise.</p>
      </header>
      <DashboardKpiBand items={summary.kpis} />
      <AdminOperationsWorkspace items={summary.workspaceItems} />
      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">Team context</h2>
          <p className="mt-1 text-sm text-gray-500">Compact business context so the admin home stays connected to active pipeline health.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-gray-50 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Pipeline</p>
              <p className="mt-2 text-2xl font-black text-gray-900">{teamSnapshot?.value ?? "—"}</p>
              <p className="mt-1 text-sm text-gray-500">{teamSnapshot?.detail ?? "Team snapshot unavailable"}</p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">Recent operational activity</h2>
          <div className="mt-4 space-y-3">
            {summary.recentActivity.map((item) => (
              <div key={item.key} className="rounded-xl bg-gray-50 px-4 py-3">
                <p className="text-sm font-semibold text-gray-900">{item.label}</p>
                <p className="mt-1 text-sm text-gray-500">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
