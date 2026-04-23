import type { SalesReviewForecastRow } from "@/hooks/use-sales-review";
import { Card, CardContent } from "@/components/ui/card";

function money(value: number | null) {
  if (value == null) return "Unknown";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

export function SalesReviewForecastTable({ rows }: { rows: SalesReviewForecastRow[] }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="mb-3">
          <p className="text-sm font-medium">30/60/90 Forecast</p>
          <p className="text-xs text-muted-foreground">Standardized rows for weekly forecast review.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="pb-2 pr-4">Record</th>
                <th className="pb-2 pr-4">Rep</th>
                <th className="pb-2 pr-4">Window</th>
                <th className="pb-2 pr-4">Category</th>
                <th className="pb-2 pr-4">Revenue</th>
                <th className="pb-2 pr-4">Profit</th>
                <th className="pb-2 pr-4">Next Milestone</th>
                <th className="pb-2">Support</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.entityType}-${row.id}`} className="border-t">
                  <td className="py-3 pr-4">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[row.companyName, row.propertyName].filter(Boolean).join(" • ") || row.stageId}
                    </div>
                  </td>
                  <td className="py-3 pr-4">{row.assignedRepName}</td>
                  <td className="py-3 pr-4">{row.forecastWindow.replace("_", " ")}</td>
                  <td className="py-3 pr-4">{row.forecastCategory ?? "Pipeline"}</td>
                  <td className="py-3 pr-4">{money(row.forecastRevenue)}</td>
                  <td className="py-3 pr-4">{money(row.forecastGrossProfit)}</td>
                  <td className="py-3 pr-4">{row.nextMilestoneAt ? new Date(row.nextMilestoneAt).toLocaleDateString() : "Missing"}</td>
                  <td className="py-3">{row.supportNeededType ?? "None"}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No forecasted records matched the current filters.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
