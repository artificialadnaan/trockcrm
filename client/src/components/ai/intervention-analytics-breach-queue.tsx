import { Link } from "react-router-dom";

import type { InterventionAnalyticsDashboard } from "@/hooks/use-ai-ops";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const severityBadgeClasses: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

const breachReasonLabels: Record<string, string> = {
  overdue: "Overdue",
  escalated_open: "Escalated",
  snooze_breached: "Snooze Breached",
  repeat_open: "Repeat Open",
};

export function InterventionAnalyticsBreachQueue(props: {
  breachQueue: InterventionAnalyticsDashboard["breachQueue"];
}) {
  const { breachQueue } = props;

  return (
    <section>
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Breach Queue</CardTitle>
          <CardDescription>
            Highest-priority cases that are overdue, escalated, breached snoozes, or repeatedly reopening.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead>Deal / Company</TableHead>
                <TableHead>Disconnect Type</TableHead>
                <TableHead className="text-right">Age</TableHead>
                <TableHead>Reasons</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breachQueue.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-sm text-slate-400">
                    No intervention breaches are active right now.
                  </TableCell>
                </TableRow>
              ) : (
                breachQueue.items.map((row) => (
                  <TableRow key={row.caseId}>
                    <TableCell>
                      <Badge variant="outline" className={severityBadgeClasses[row.severity] ?? severityBadgeClasses.low}>
                        {row.severity}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-slate-900">{row.dealLabel ?? "Unknown deal"}</div>
                      <div className="text-xs text-slate-500">{row.companyLabel ?? "Unknown company"}</div>
                    </TableCell>
                    <TableCell className="text-slate-700">{row.disconnectType}</TableCell>
                    <TableCell className="text-right font-semibold text-slate-900">{row.ageDays}d</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {row.breachReasons.map((reason) => (
                          <Badge key={`${row.caseId}-${reason}`} variant="outline">
                            {breachReasonLabels[reason]}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{row.assignedTo ?? "Unassigned"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-3">
                        <Link to={row.detailLink} className="text-xs font-semibold uppercase tracking-[0.14em] text-[#CC0000]">
                          Case
                        </Link>
                        <Link to={row.queueLink} className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
                          Queue
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <div className="mt-3 text-xs uppercase tracking-[0.16em] text-slate-400">
            Showing {breachQueue.items.length} of {breachQueue.totalCount} breach rows
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
