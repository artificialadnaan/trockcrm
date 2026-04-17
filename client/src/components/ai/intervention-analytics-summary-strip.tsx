import { Link } from "react-router-dom";

import { buildInterventionWorkspacePath } from "@/hooks/use-admin-interventions";
import type { InterventionAnalyticsDashboard } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function SummaryMetricCard(props: {
  label: string;
  value: number;
  description: string;
  to: string;
}) {
  return (
    <Card className="bg-white">
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-[0.16em] text-slate-500">{props.label}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-4">
        <div className="text-4xl font-black tracking-tight text-slate-900">{props.value}</div>
        <Link to={props.to} className="text-xs font-semibold uppercase tracking-[0.16em] text-[#CC0000]">
          Open Queue
        </Link>
      </CardContent>
    </Card>
  );
}

function SeverityBreakdown(props: {
  title: string;
  counts: InterventionAnalyticsDashboard["summary"]["openCasesBySeverity"];
  view?: "open" | "overdue";
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{props.title}</div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["critical", "high", "medium", "low"] as const).map((severity) => (
          <Link
            key={severity}
            to={buildInterventionWorkspacePath({
              view: props.view === "overdue" ? "overdue" : "open",
              severity,
            })}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 transition-colors hover:border-slate-300 hover:bg-slate-100"
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{severity}</div>
            <div className="mt-1 text-2xl font-black text-slate-900">{props.counts[severity] ?? 0}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function InterventionAnalyticsSummaryStrip(props: {
  summary: InterventionAnalyticsDashboard["summary"];
}) {
  const { summary } = props;

  return (
    <section className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <SummaryMetricCard
          label="Open Cases"
          value={summary.openCases}
          description="Active intervention cases in the current office."
          to={buildInterventionWorkspacePath({ view: "open" })}
        />
        <SummaryMetricCard
          label="Overdue Cases"
          value={summary.overdueCases}
          description="Open cases breaching the SLA threshold."
          to={buildInterventionWorkspacePath({ view: "overdue" })}
        />
        <SummaryMetricCard
          label="Escalated Cases"
          value={summary.escalatedCases}
          description="Escalated cases still requiring leadership attention."
          to={buildInterventionWorkspacePath({ view: "escalated" })}
        />
        <SummaryMetricCard
          label="Snoozes Past Due"
          value={summary.snoozeOverdueCases}
          description="Snoozed cases whose deadline has already expired."
          to={buildInterventionWorkspacePath({ view: "snooze-breached" })}
        />
        <SummaryMetricCard
          label="Repeat Cases Open"
          value={summary.repeatOpenCases}
          description="Cases reopened at least once and still active."
          to={buildInterventionWorkspacePath({ view: "repeat" })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SeverityBreakdown title="Open Cases By Severity" counts={summary.openCasesBySeverity} view="open" />
        <SeverityBreakdown title="Overdue Cases By Severity" counts={summary.overdueCasesBySeverity} view="overdue" />
      </div>
    </section>
  );
}
