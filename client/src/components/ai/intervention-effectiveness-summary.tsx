import type { InterventionOutcomeEffectiveness } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function formatRate(value: number | null) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function formatMedianDays(value: number | null) {
  if (value === null) return "n/a";
  return `${value}d`;
}

export function InterventionEffectivenessSummary(props: InterventionOutcomeEffectiveness) {
  return (
    <Card className="border-border/80 bg-white shadow-sm">
      <CardHeader>
        <CardTitle>Resolution Effectiveness</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-border/70 p-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Resolve reopen rate</div>
            <div className="mt-2 text-2xl font-black">{formatRate(props.reopenRateByConclusionFamily.resolve)}</div>
          </div>
          <div className="rounded-lg border border-border/70 p-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Snooze reopen rate</div>
            <div className="mt-2 text-2xl font-black">{formatRate(props.reopenRateByConclusionFamily.snooze)}</div>
          </div>
          <div className="rounded-lg border border-border/70 p-4">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Escalate reopen rate</div>
            <div className="mt-2 text-2xl font-black">{formatRate(props.reopenRateByConclusionFamily.escalate)}</div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border/70 p-4">
            <div className="text-sm font-semibold">Conclusion mix by disconnect type</div>
            <div className="mt-3 space-y-2 text-sm">
              {props.conclusionMixByDisconnectType.map((row) => (
                <div key={row.key}>
                  {row.key}: {row.resolveCount} resolve / {row.snoozeCount} snooze / {row.escalateCount} escalate
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border/70 p-4">
            <div className="text-sm font-semibold">Median days to reopen</div>
            <div className="mt-3 space-y-2 text-sm">
              {props.medianDaysToReopenByConclusionFamily.map((row) => (
                <div key={row.key}>
                  {row.key}: {formatMedianDays(row.medianDays)}
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
