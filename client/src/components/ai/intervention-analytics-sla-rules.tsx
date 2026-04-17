import type { InterventionAnalyticsDashboard } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function InterventionAnalyticsSlaRules(props: {
  slaRules: InterventionAnalyticsDashboard["slaRules"];
}) {
  const { slaRules } = props;

  return (
    <section>
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>SLA Rules</CardTitle>
          <CardDescription>Deterministic thresholds and breach logic used for the analytics page.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Critical</div>
              <div className="mt-1 text-2xl font-black text-slate-900">{slaRules.criticalDays}d</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">High</div>
              <div className="mt-1 text-2xl font-black text-slate-900">{slaRules.highDays}d</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Medium</div>
              <div className="mt-1 text-2xl font-black text-slate-900">{slaRules.mediumDays}d</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Low</div>
              <div className="mt-1 text-2xl font-black text-slate-900">{slaRules.lowDays}d</div>
            </div>
          </div>

          <div className="space-y-3 text-sm leading-6 text-slate-600">
            <p>
              Timing basis: <span className="font-semibold text-slate-900">{slaRules.timingBasis.replace("_", " ")}</span>
            </p>
            <p>Overdue means an open case has aged beyond its severity threshold.</p>
            <p>Snooze breached means a snoozed case has passed its `snoozedUntil` time and still needs action.</p>
            <p>Escalated still-open and repeat-open cases remain visible in the breach queue even when they also match another breach reason.</p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
