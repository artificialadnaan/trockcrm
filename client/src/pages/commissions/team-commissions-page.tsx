import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/page-header";
import { useDirectorCommissionWorkspace, presetToDateRange } from "@/hooks/use-director-dashboard";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const PERCENT = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatCurrency(value: number): string {
  return USD.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number): string {
  return PERCENT.format(Number.isFinite(value) ? value : 0);
}

export function TeamCommissionsPage() {
  const { data, loading, error } = useDirectorCommissionWorkspace(presetToDateRange("ytd"));
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Director"
        title="Team Commissions"
        description="Commission totals, activity, and funnel stage mix for each rep in your team."
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        {loading ? (
          <p className="text-sm text-slate-500">Loading team commissions...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">No reps found for commission reporting.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.14em] text-slate-500">
                  <th className="px-3 py-2 text-left">Rep</th>
                  <th className="px-3 py-2 text-right">Earned</th>
                  <th className="px-3 py-2 text-right">Potential</th>
                  <th className="px-3 py-2 text-right">Active Deals</th>
                  <th className="px-3 py-2 text-right">Pipeline</th>
                  <th className="px-3 py-2 text-right">L / Q / O</th>
                  <th className="px-3 py-2 text-right">Estimating</th>
                  <th className="px-3 py-2 text-right">Calls / Emails / Meetings</th>
                  <th className="px-3 py-2 text-right">Activities</th>
                  <th className="px-3 py-2 text-right">New Mix</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.repId} className="border-b border-slate-100">
                    <td className="px-3 py-2">
                      <Link
                        to={`/director/rep/${row.repId}`}
                        className="font-medium text-slate-900 underline-offset-2 hover:underline"
                      >
                        {row.repName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-900">
                      {formatCurrency(row.totalEarnedCommission)}
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(row.potentialCommission)}</td>
                    <td className="px-3 py-2 text-right">{row.activeDeals}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(row.pipelineValue)}</td>
                    <td className="px-3 py-2 text-right">
                      {row.leads} / {row.qualifiedLeads} / {row.opportunities}
                    </td>
                    <td className="px-3 py-2 text-right">{row.estimating}</td>
                    <td className="px-3 py-2 text-right">
                      {row.calls} / {row.emails} / {row.meetings}
                    </td>
                    <td className="px-3 py-2 text-right">{row.totalActivities}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={row.meetsNewCustomerShare ? "text-emerald-700" : "text-amber-700"}>
                        {formatPercent(row.newCustomerShare)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
