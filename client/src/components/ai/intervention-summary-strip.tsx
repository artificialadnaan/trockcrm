import { AlertTriangle, Clock3, ShieldAlert, UserRoundCheck } from "lucide-react";
import type { InterventionQueueItem } from "@/hooks/use-admin-interventions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function InterventionSummaryStrip({
  items,
  totalCount,
  totalLabel,
}: {
  items: InterventionQueueItem[];
  totalCount: number;
  totalLabel: string;
}) {
  const snoozedCount = items.filter((item) => item.status === "snoozed").length;
  const escalatedCount = items.filter((item) => item.escalated).length;
  const unassignedCount = items.filter((item) => !item.assignedTo).length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4" />
            {totalLabel}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-black">{totalCount}</div>
          <div className="text-sm text-muted-foreground">Cases in the current queue</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock3 className="h-4 w-4" />
            Snoozed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-black">{snoozedCount}</div>
          <div className="text-sm text-muted-foreground">Shown on this page</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldAlert className="h-4 w-4" />
            Escalated
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-black">{escalatedCount}</div>
          <div className="text-sm text-muted-foreground">Shown on this page</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <UserRoundCheck className="h-4 w-4" />
            Unassigned
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-black">{unassignedCount}</div>
          <div className="text-sm text-muted-foreground">Shown on this page</div>
        </CardContent>
      </Card>
    </div>
  );
}
