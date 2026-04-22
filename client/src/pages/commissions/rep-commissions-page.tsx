import { useRepDashboard } from "@/hooks/use-dashboard";
import { PageHeader } from "@/components/layout/page-header";
import { Link } from "react-router-dom";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const PERCENT = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatCurrency(value: number) {
  return USD.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number) {
  return PERCENT.format(Number.isFinite(value) ? value : 0);
}

export function RepCommissionsPage() {
  const { data, loading, error } = useRepDashboard();
  const summary = data?.commissionSummary;
  const commissionDeals = data?.commissionDeals ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales"
        title="Commissions"
        description="Commissions are calculated from deal payment events recorded as cash received."
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Commission summary cards">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Earned</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {loading || !summary ? "..." : formatCurrency(summary.totalEarnedCommission)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {loading || !summary
              ? "Loading"
              : `${formatCurrency(summary.directEarnedCommission)} direct + ${formatCurrency(summary.overrideEarnedCommission)} override`}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Rates</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {loading || !summary ? "..." : formatPercent(summary.commissionRate)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {loading || !summary ? "Loading" : `${formatPercent(summary.overrideRate)} override`}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Rolling Floor</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {loading || !summary ? "..." : formatCurrency(summary.floorRemaining)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {loading || !summary
              ? "Loading"
              : `${formatCurrency(summary.rollingPaidRevenue)} paid vs ${formatCurrency(summary.rollingFloor)} floor`}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">New Customer Mix</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {loading || !summary ? "..." : formatPercent(summary.newCustomerShare)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {loading || !summary
              ? "Loading"
              : `${summary.meetsNewCustomerShare ? "Meets" : "Below"} ${formatPercent(summary.newCustomerShareFloor)} requirement`}
          </p>
        </div>
      </section>

      {!loading && summary && !summary.meetsNewCustomerShare ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          New customer mix is below {formatPercent(summary.newCustomerShareFloor)}. This is a warning only and does
          not block earned commission accrual.
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Calculation Inputs</h2>
        <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            Payment events counted:{" "}
            <span className="font-semibold text-slate-900">
              {loading || !summary ? "--" : summary.estimatedPaymentCount}
            </span>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            Commissionable margin:{" "}
            <span className="font-semibold text-slate-900">
              {loading || !summary ? "--" : formatCurrency(summary.rollingCommissionableMargin)}
            </span>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            Potential commission:{" "}
            <span className="font-semibold text-slate-900">
              {loading || !summary ? "--" : formatCurrency(summary.potentialCommission)}
            </span>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            Excluded low-margin revenue:{" "}
            <span className="font-semibold text-slate-900">
              {loading || !summary ? "--" : formatCurrency(summary.excludedLowMarginRevenue)}
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Commission By Deal</h2>
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Click a deal to open details</p>
        </div>
        {loading ? (
          <p className="mt-4 text-sm text-slate-500">Loading deals...</p>
        ) : commissionDeals.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No deals with accrued commission yet.</p>
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {commissionDeals.map((deal) => (
              <Link
                key={deal.dealId}
                to={`/deals/${deal.dealId}`}
                className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 transition-colors hover:border-slate-300 hover:bg-slate-100"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950">
                      {deal.dealNumber ? `${deal.dealNumber} - ` : ""}
                      {deal.dealName}
                    </p>
                    <p className="mt-1 truncate text-xs text-slate-600">
                      {[deal.companyName, deal.propertyName].filter(Boolean).join(" • ") || "No company/property linked"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {deal.paymentCount} payment event{deal.paymentCount === 1 ? "" : "s"}
                      {deal.lastPaidAt ? ` • Last paid ${new Date(deal.lastPaidAt).toLocaleDateString("en-US")}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-slate-950">{formatCurrency(deal.earnedCommission)}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatCurrency(deal.commissionableMargin)} margin</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
