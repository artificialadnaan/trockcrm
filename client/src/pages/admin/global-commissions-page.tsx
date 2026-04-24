import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { api } from "@/lib/api";

type GlobalCommissionRow = {
  officeId: string;
  officeName: string;
  officeSlug: string;
  repId: string;
  repName: string;
  totalEarnedCommission: number;
  potentialCommission: number;
  floorRemaining: number;
  newCustomerShare: number;
  meetsNewCustomerShare: boolean;
  activeDeals: number;
  pipelineValue: number;
  leads: number;
  qualifiedLeads: number;
  opportunities: number;
  estimating: number;
  calls: number;
  emails: number;
  meetings: number;
  notes: number;
  totalActivities: number;
};

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

export function GlobalCommissionsPage() {
  const [rows, setRows] = useState<GlobalCommissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api<{ rows: GlobalCommissionRow[] }>("/admin/reports/global-commissions")
      .then((response) => {
        if (cancelled) return;
        setRows(response.rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(err instanceof Error ? err.message : "Failed to load global commissions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Global Commissions"
        description="Rep-level commission, activity, and funnel coverage across all offices."
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        {loading ? (
          <p className="text-sm text-slate-500">Loading global commissions...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">No global commission rows found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.14em] text-slate-500">
                  <th className="px-3 py-2 text-left">Office</th>
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
                  <tr key={`${row.officeId}:${row.repId}`} className="border-b border-slate-100">
                    <td className="px-3 py-2">{row.officeName}</td>
                    <td className="px-3 py-2 font-medium text-slate-900">{row.repName}</td>
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
