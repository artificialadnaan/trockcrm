import { PageHeader } from "@/components/layout/page-header";
import { ReportBuilder } from "@/components/reports/report-builder";
import { useSavedReports } from "@/hooks/use-reports";
import type { UserRole } from "@trock-crm/shared/types";

export function canViewDataMiningSection(role: UserRole | undefined) {
  return role === "director";
}

export function ReportsPage() {
  const { reports, loading, error, refetch } = useSavedReports();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Analytics"
        title="Reports"
        description="Build reusable pipeline reports from approved dimensions, measures, filters, and date fields."
      />

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          Loading saved views...
        </div>
      ) : null}

      <ReportBuilder savedReports={reports} onSaved={refetch} />
    </div>
  );
}
