import type { InterventionAnalyticsDashboard } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InterventionAnalyticsSlaRulesProps {
  rules: InterventionAnalyticsDashboard["slaRules"];
}

export function InterventionAnalyticsSlaRules({ rules }: InterventionAnalyticsSlaRulesProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deterministic SLA Rules</CardTitle>
        <CardDescription>
          These manager analytics are driven by fixed business rules over intervention cases, not AI scoring.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-4">
          <div className="text-[11px] uppercase tracking-widest text-red-700">Critical</div>
          <div className="mt-2 text-3xl font-black text-red-950">{rules.criticalDays}d</div>
        </div>
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-4">
          <div className="text-[11px] uppercase tracking-widest text-orange-700">High</div>
          <div className="mt-2 text-3xl font-black text-orange-950">{rules.highDays}d</div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4">
          <div className="text-[11px] uppercase tracking-widest text-amber-700">Medium</div>
          <div className="mt-2 text-3xl font-black text-amber-950">{rules.mediumDays}d</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-100 px-4 py-4">
          <div className="text-[11px] uppercase tracking-widest text-slate-700">Low</div>
          <div className="mt-2 text-3xl font-black text-slate-950">{rules.lowDays}d</div>
        </div>
        <div className="md:col-span-2 xl:col-span-4 rounded-lg border border-border/80 bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
          Timing basis: {rules.timingBasis.replace(/_/g, " ")}. Snoozed cases can still breach once the snooze date passes.
          Repeat-open cases and unresolved escalations are elevated into the manager breach queue automatically.
        </div>
      </CardContent>
    </Card>
  );
}
