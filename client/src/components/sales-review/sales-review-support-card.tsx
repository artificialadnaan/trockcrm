import type { SalesReviewForecastRow } from "@/hooks/use-sales-review";
import { Card, CardContent } from "@/components/ui/card";

export function SalesReviewSupportCard({ rows }: { rows: SalesReviewForecastRow[] }) {
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div>
          <p className="text-sm font-medium">Support Requests</p>
          <p className="text-xs text-muted-foreground">Records actively asking for leadership, estimating, or operations help.</p>
        </div>
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={`${row.entityType}-${row.id}`} className="rounded-md border p-3">
              <div className="font-medium">{row.name}</div>
              <div className="text-xs text-muted-foreground">{row.assignedRepName}</div>
              <div className="mt-1 text-xs">{row.supportNeededType}</div>
            </div>
          ))}
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">No active support requests.</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
