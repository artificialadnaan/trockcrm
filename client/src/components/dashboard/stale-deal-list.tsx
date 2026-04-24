import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/components/charts/chart-colors";
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";

interface StaleDeal {
  dealId: string;
  dealNumber: string;
  dealName: string;
  stageName: string;
  repName: string;
  daysInStage: number;
  dealValue: number;
}

interface StaleDealListProps {
  deals: StaleDeal[];
}

export function StaleDealList({ deals }: StaleDealListProps) {
  if (deals.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Stale Deal Watchlist
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm text-center py-4">
            No stale deals. All deals are progressing on time.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="rounded-t-lg p-0">
        <Link
          to="/reports#stale-deals"
          className="flex items-center gap-2 rounded-t-lg px-6 py-4 hover:bg-slate-50 transition-colors"
        >
          <CardTitle className="flex flex-1 items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Stale Deal Watchlist
          </CardTitle>
          <Badge variant="secondary">{deals.length}</Badge>
        </Link>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {deals.slice(0, 10).map((deal) => (
            <Link
              key={deal.dealId}
              to={`/deals/${deal.dealId}`}
              className="flex items-center justify-between p-2 rounded-md hover:bg-slate-50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{deal.dealName}</p>
                <p className="text-xs text-muted-foreground">
                  {deal.repName} &mdash; {deal.stageName}
                </p>
              </div>
              <div className="text-right ml-3 shrink-0">
                <p className="text-sm font-medium text-amber-600">
                  {deal.daysInStage}d
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(deal.dealValue)}
                </p>
              </div>
            </Link>
          ))}
          {deals.length > 10 && (
            <p className="text-xs text-muted-foreground text-center pt-2">
              +{deals.length - 10} more stale deals
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
