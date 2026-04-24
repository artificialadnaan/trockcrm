import type { DataMiningOverview } from "@/hooks/use-reports";

function formatDate(value: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function MetricCard({ label, value, helper }: { label: string; value: number; helper: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-3xl font-black tracking-tight text-slate-900">{value.toLocaleString()}</p>
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-500">
          {helper}
        </span>
      </div>
    </div>
  );
}

function EmptyTable({ columns, message }: { columns: number; message: string }) {
  return (
    <tr>
      <td colSpan={columns} className="px-4 py-8 text-center text-sm text-slate-400">
        {message}
      </td>
    </tr>
  );
}

export function DataMiningSection({
  data,
  loading,
  error,
}: {
  data: DataMiningOverview | null;
  loading: boolean;
  error?: string | null;
}) {
  if (loading) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
        Loading data mining...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
        No data-mining records found for the selected filters.
      </div>
    );
  }

  const untouchedContacts = data.untouchedContacts.filter((row) => Boolean(row.contactId && row.contactName));
  const dormantCompanies = data.dormantCompanies.filter((row) => Boolean(row.companyId && row.companyName));

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#CC0000]">Data Mining</p>
        <h2 className="text-2xl font-black tracking-tight text-slate-900">
          Untouched Contacts and Dormant Companies
        </h2>
        <p className="text-sm leading-relaxed text-slate-500">
          A separate reactivation surface for contacts and companies that have gone quiet,
          without duplicating stale workflow widgets or ownership-gap diagnostics.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Untouched 30d+"
          value={data.summary.untouchedContact30Count}
          helper="contacts"
        />
        <MetricCard
          label="Untouched 60d+"
          value={data.summary.untouchedContact60Count}
          helper="contacts"
        />
        <MetricCard
          label="Untouched 90d+"
          value={data.summary.untouchedContact90Count}
          helper="contacts"
        />
        <MetricCard
          label="Dormant 90d+"
          value={data.summary.dormantCompany90Count}
          helper="companies"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="text-base font-bold text-slate-900">Untouched Contacts</h3>
            <p className="text-xs text-slate-400">Contacts with no recent touchpoint or activity.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3 text-right">Days</th>
                  <th className="px-4 py-3">Last Touched</th>
                </tr>
              </thead>
              <tbody className="text-sm text-slate-700">
                {untouchedContacts.length === 0 ? (
                  <EmptyTable columns={4} message="No untouched contacts found." />
                ) : (
                  untouchedContacts.map((row) => (
                    <tr key={row.contactId} className="border-b border-slate-50 last:border-b-0">
                      <td className="px-4 py-4 font-medium text-slate-900">{row.contactName}</td>
                      <td className="px-4 py-4">{row.companyName}</td>
                      <td className="px-4 py-4 text-right tabular-nums">{row.daysSinceTouch}</td>
                      <td className="px-4 py-4 text-slate-500">{formatDate(row.lastTouchedAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-4">
            <h3 className="text-base font-bold text-slate-900">Dormant Companies</h3>
            <p className="text-xs text-slate-400">Companies with no recent activity and no active deal.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3 text-right">Days</th>
                  <th className="px-4 py-3 text-right">Active Deals</th>
                  <th className="px-4 py-3">Last Activity</th>
                </tr>
              </thead>
              <tbody className="text-sm text-slate-700">
                {dormantCompanies.length === 0 ? (
                  <EmptyTable columns={4} message="No dormant companies found." />
                ) : (
                  dormantCompanies.map((row) => (
                    <tr key={row.companyId} className="border-b border-slate-50 last:border-b-0">
                      <td className="px-4 py-4 font-medium text-slate-900">{row.companyName}</td>
                      <td className="px-4 py-4 text-right tabular-nums">{row.daysSinceActivity}</td>
                      <td className="px-4 py-4 text-right tabular-nums">{row.activeDealCount}</td>
                      <td className="px-4 py-4 text-slate-500">{formatDate(row.lastActivityAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
