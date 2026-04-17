import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Gauge, Repeat2, ShieldAlert, TimerReset } from "lucide-react";
import type { InterventionAnalyticsDashboard } from "@/hooks/use-ai-ops";
import { buildInterventionWorkspacePath } from "@/hooks/use-admin-interventions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const severityOrder = ["critical", "high", "medium", "low"] as const;

const severityClasses: Record<string, string> = {
  critical: "border-red-200 bg-red-50 text-red-700",
  high: "border-orange-200 bg-orange-50 text-orange-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-slate-200 bg-slate-100 text-slate-700",
};

interface InterventionAnalyticsSummaryStripProps {
  summary: InterventionAnalyticsDashboard["summary"];
}

function SummaryCardLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className="block transition-transform hover:-translate-y-0.5">
      {children}
    </Link>
  );
}

export function InterventionAnalyticsSummaryStrip({ summary }: InterventionAnalyticsSummaryStripProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
      <SummaryCardLink to={buildInterventionWorkspacePath({ view: "open" })}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Gauge className="h-4 w-4" /> Open Cases</CardTitle>
            <CardDescription>Current intervention workload</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-4xl font-black">{summary.openCases}</div>
            <div className="flex flex-wrap gap-2">
              {severityOrder.map((severity) => (
                <Badge key={severity} variant="outline" className={severityClasses[severity]}>
                  {severity}: {summary.openCasesBySeverity[severity] ?? 0}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </SummaryCardLink>

      <SummaryCardLink to={buildInterventionWorkspacePath({ view: "overdue" })}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><TimerReset className="h-4 w-4" /> Overdue</CardTitle>
            <CardDescription>Cases beyond SLA thresholds</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-4xl font-black">{summary.overdueCases}</div>
            <div className="flex flex-wrap gap-2">
              {severityOrder.map((severity) => (
                <Badge key={severity} variant="outline" className={severityClasses[severity]}>
                  {severity}: {summary.overdueCasesBySeverity[severity] ?? 0}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </SummaryCardLink>

      <SummaryCardLink to={buildInterventionWorkspacePath({ view: "escalated" })}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Escalated</CardTitle>
            <CardDescription>Open escalations needing attention</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-black">{summary.escalatedCases}</div>
          </CardContent>
        </Card>
      </SummaryCardLink>

      <SummaryCardLink to={buildInterventionWorkspacePath({ view: "snooze-breached" })}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Snooze Breaches</CardTitle>
            <CardDescription>Snoozes past due for review</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-black">{summary.snoozeOverdueCases}</div>
          </CardContent>
        </Card>
      </SummaryCardLink>

      <SummaryCardLink to={buildInterventionWorkspacePath({ view: "repeat" })}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Repeat2 className="h-4 w-4" /> Repeat Open</CardTitle>
            <CardDescription>Cases that have reopened</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-black">{summary.repeatOpenCases}</div>
          </CardContent>
        </Card>
      </SummaryCardLink>
    </div>
  );
}
