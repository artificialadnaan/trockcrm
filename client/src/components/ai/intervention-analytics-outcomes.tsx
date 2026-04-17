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

export function InterventionAnalyticsOutcomes(props: {
  outcomes: InterventionAnalyticsDashboard["outcomes"];
}) {
  const { outcomes } = props;

  return (
    <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Outcomes</CardTitle>
          <CardDescription>Resolution quality and current case age across the intervention lifecycle.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Clearance Rate 30d</div>
            <div className="mt-1 text-3xl font-black text-slate-900">{formatPercent(outcomes.clearanceRate30d)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Reopen Rate 30d</div>
            <div className="mt-1 text-3xl font-black text-slate-900">{formatPercent(outcomes.reopenRate30d)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Avg Age To Resolution</div>
            <div className="mt-1 text-3xl font-black text-slate-900">{formatDays(outcomes.averageAgeToResolution)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Avg Open Age</div>
            <div className="mt-1 text-3xl font-black text-slate-900">{formatDays(outcomes.averageAgeOfOpenCases)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Median Open Age</div>
            <div className="mt-1 text-3xl font-black text-slate-900">{formatDays(outcomes.medianAgeOfOpenCases)}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Action Volume</CardTitle>
          <CardDescription>Intervention actions logged over the last 30 days.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(["assign", "snooze", "resolve", "escalate"] as const).map((action) => (
            <div key={action} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-sm font-medium capitalize text-slate-700">{action}</div>
              <div className="text-2xl font-black text-slate-900">{outcomes.actionVolume30d[action] ?? 0}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
