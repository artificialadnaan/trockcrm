import { Link } from "react-router-dom";
import type { InterventionAnalyticsBreachRow } from "@/hooks/use-ai-ops";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const severityClasses: Record<string, string> = {
  critical: "border-red-200 bg-red-50 text-red-700",
  high: "border-orange-200 bg-orange-50 text-orange-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-slate-200 bg-slate-100 text-slate-700",
};

function formatReason(reason: InterventionAnalyticsBreachRow["breachReasons"][number]) {
  return reason.replace(/_/g, " ");
}

interface InterventionAnalyticsBreachQueueProps {
  breachQueue: {
    items: InterventionAnalyticsBreachRow[];
    totalCount: number;
    pageSize: number;
  };
}

export function InterventionAnalyticsBreachQueue({ breachQueue }: InterventionAnalyticsBreachQueueProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Breach Queue</CardTitle>
        <CardDescription>
          Manager attention queue for overdue, escalated, snooze-breached, and repeat-open intervention cases
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Deal</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Reasons</TableHead>
              <TableHead className="text-right">Age</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {breachQueue.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  No cases are currently breaching the deterministic SLA rules.
                </TableCell>
              </TableRow>
            ) : (
              breachQueue.items.map((item) => (
                <TableRow key={item.caseId}>
                  <TableCell>
                    <div className="space-y-1">
                      {item.detailLink ? (
                        <Link to={item.detailLink} className="font-medium text-brand-red hover:underline">
                          {item.dealLabel ?? "Unlinked deal"}
                        </Link>
                      ) : (
                        <div className="font-medium">{item.dealLabel ?? "Unlinked deal"}</div>
                      )}
                      <Badge variant="outline" className={severityClasses[item.severity] ?? severityClasses.low}>
                        {item.severity}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>{item.companyLabel ?? "Unlinked company"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {item.breachReasons.map((reason) => (
                        <Badge key={reason} variant="outline">
                          {formatReason(reason)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{item.ageDays}d</TableCell>
                  <TableCell>{item.assignedTo ?? "Unassigned"}</TableCell>
                  <TableCell className="text-right">
                    <Link to={item.queueLink} className="text-sm font-medium text-brand-red hover:underline">
                      Open queue
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {breachQueue.totalCount > breachQueue.pageSize && (
          <div className="mt-4 text-sm text-muted-foreground">
            Showing the first {breachQueue.pageSize} breach cases of {breachQueue.totalCount}.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
