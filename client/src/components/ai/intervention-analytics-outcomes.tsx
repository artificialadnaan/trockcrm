import { CheckCircle2, Clock3, Repeat2, Workflow } from "lucide-react";
import type { InterventionAnalyticsDashboard } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function formatPercent(value: number | null) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return `${Math.round(value * 100)}%`;
}

function formatDays(value: number | null) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}d`;
}

interface InterventionAnalyticsOutcomesProps {
  outcomes: InterventionAnalyticsDashboard["outcomes"];
}

export function InterventionAnalyticsOutcomes({ outcomes }: InterventionAnalyticsOutcomesProps) {
  const actionVolume = Object.entries(outcomes.actionVolume30d);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[0.9fr_1.1fr] gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Clearance Rate</CardTitle>
            <CardDescription>Resolved cases vs intervened cases in 30 days</CardDescription>
          </CardHeader>
          <CardContent className="text-4xl font-black">{formatPercent(outcomes.clearanceRate30d)}</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Repeat2 className="h-4 w-4" /> Reopen Rate</CardTitle>
            <CardDescription>Reopened cases after prior resolution</CardDescription>
          </CardHeader>
          <CardContent className="text-4xl font-black">{formatPercent(outcomes.reopenRate30d)}</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock3 className="h-4 w-4" /> Avg Open Age</CardTitle>
            <CardDescription>Business-day age of currently open cases</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-4xl font-black">{formatDays(outcomes.averageAgeOfOpenCases)}</div>
            <div className="text-sm text-muted-foreground">Median: {formatDays(outcomes.medianAgeOfOpenCases)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Workflow className="h-4 w-4" /> Avg Resolution Time</CardTitle>
            <CardDescription>Average age when cases resolve</CardDescription>
          </CardHeader>
          <CardContent className="text-4xl font-black">{formatDays(outcomes.averageAgeToResolution)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Action Volume</CardTitle>
          <CardDescription>Intervention activity over the last 30 days</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {actionVolume.length === 0 ? (
            <div className="col-span-full rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No intervention actions recorded in the last 30 days.
            </div>
          ) : (
            actionVolume.map(([action, count]) => (
              <div key={action} className="rounded-lg border border-border/80 bg-muted/20 px-4 py-4">
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  {action.replace(/_/g, " ")}
                </div>
                <div className="mt-2 text-3xl font-black">{count}</div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
