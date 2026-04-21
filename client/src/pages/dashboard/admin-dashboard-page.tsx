import { buildAdminOperationsTiles } from "@/lib/admin-dashboard-summary";
import { useAdminDashboardSummary } from "@/hooks/use-admin-dashboard-summary";
import { AdminOperationsWorkspace } from "@/components/dashboard/admin-operations-workspace";

export function AdminDashboardPage() {
  const { data, loading, error } = useAdminDashboardSummary();

  if (loading) return <div className="text-sm text-slate-500">Loading operations console...</div>;
  if (error || !data) return <div className="text-sm text-red-600">{error ?? "Failed to load admin dashboard"}</div>;

  const tiles = buildAdminOperationsTiles(data);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Operations Console</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          Admin home is now organized around operational risk and queue health first, with sales context kept secondary.
        </p>
      </div>
      <AdminOperationsWorkspace tiles={tiles} />
    </div>
  );
}
