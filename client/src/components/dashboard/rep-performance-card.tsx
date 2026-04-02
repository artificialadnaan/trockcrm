import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/components/charts/chart-colors";
import { AlertTriangle } from "lucide-react";
import type { RepPerformanceCard as RepCardData } from "@/hooks/use-director-dashboard";

interface RepPerformanceCardProps {
  rep: RepCardData;
  onClick: () => void;
}

export function RepPerformanceCard({ rep, onClick }: RepPerformanceCardProps) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm truncate">{rep.repName}</h3>
          {rep.staleDeals > 0 && (
            <span className="flex items-center gap-1 text-amber-600 text-xs">
              <AlertTriangle className="h-3 w-3" />
              {rep.staleDeals}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Active Deals</p>
            <p className="text-lg font-bold">{rep.activeDeals}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Pipeline</p>
            <p className="text-lg font-bold">{formatCurrency(rep.pipelineValue)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Win Rate</p>
            <p className={`text-lg font-bold ${rep.winRate >= 50 ? "text-emerald-600" : rep.winRate > 0 ? "text-amber-600" : "text-muted-foreground"}`}>
              {rep.winRate}%
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Activities</p>
            <p className="text-lg font-bold">{rep.activityScore}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
