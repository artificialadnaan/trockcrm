import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { SalesReviewFilters } from "@/components/sales-review/sales-review-filters";
import { SalesReviewForecastTable } from "@/components/sales-review/sales-review-forecast-table";
import { SalesReviewActivityCard } from "@/components/sales-review/sales-review-activity-card";
import { SalesReviewHygieneCard } from "@/components/sales-review/sales-review-hygiene-card";
import { SalesReviewSupportCard } from "@/components/sales-review/sales-review-support-card";
import { useSalesReview } from "@/hooks/use-sales-review";

function formatDateInput(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function SalesReviewPage() {
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(formatDateInput(new Date(today.getTime() - 14 * 86_400_000)));
  const [to, setTo] = useState(formatDateInput(today));
  const [forecastWindow, setForecastWindow] = useState("all");
  const { data, loading, error } = useSalesReview({
    from,
    to,
    forecastWindow: forecastWindow === "all" ? undefined : forecastWindow as any,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales"
        title="Sales Review"
        description="Run the weekly forecast and pipeline hygiene meeting from CRM data instead of a spreadsheet."
        secondaryRow={
          <SalesReviewFilters
            from={from}
            to={to}
            forecastWindow={forecastWindow}
            onFromChange={setFrom}
            onToChange={setTo}
            onForecastWindowChange={setForecastWindow}
          />
        }
      />

      {loading ? <div className="text-sm text-muted-foreground">Loading sales review...</div> : null}
      {error ? <div className="text-sm text-red-600">{error}</div> : null}

      {data ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">New Opportunities</p>
              <p className="mt-2 text-3xl font-semibold">{data.newOpportunities.length}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Forecasted Records</p>
              <p className="mt-2 text-3xl font-semibold">{data.forecast.length}</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Hygiene Issues</p>
              <p className="mt-2 text-3xl font-semibold">{data.hygiene.length}</p>
            </div>
          </div>

          <SalesReviewForecastTable rows={data.forecast} />

          <div className="grid gap-4 lg:grid-cols-3">
            <SalesReviewActivityCard rows={data.activityCadence} />
            <SalesReviewHygieneCard rows={data.hygiene} />
            <SalesReviewSupportCard rows={data.supportRequests} />
          </div>
        </>
      ) : null}
    </div>
  );
}
