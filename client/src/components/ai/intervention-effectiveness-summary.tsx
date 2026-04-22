import { Link } from "react-router-dom";
import type { InterventionOutcomeEffectiveness } from "@/hooks/use-ai-ops";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InterventionEffectivenessReasonTable } from "./intervention-effectiveness-reason-table";
import { InterventionEffectivenessWarnings } from "./intervention-effectiveness-warnings";

function formatPercent(value: number | null) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function formatDays(value: number | null) {
  if (value === null) return "n/a";
  return `${value}d`;
}

export function InterventionEffectivenessSummary(props: InterventionOutcomeEffectiveness) {
  return (
    <div className="space-y-4">
      <Card className="border-border/80 bg-white shadow-sm">
        <CardHeader>
          <CardTitle>Resolution Effectiveness</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {props.summaryByConclusionFamily.map((row) => (
              <Link
                key={row.key}
                to={row.queueLink}
                className="block rounded-lg border border-border/70 p-4 transition-colors hover:border-brand-red/40 hover:bg-muted/20"
              >
                <div className="text-xs uppercase tracking-widest text-muted-foreground">{row.label}</div>
                <div className="mt-3 grid gap-3 text-sm">
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Durable close rate</div>
                    <div className="mt-1 text-2xl font-black text-gray-900">{formatPercent(row.durableCloseRate)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Reopen rate</div>
                    <div className="mt-1 font-semibold text-gray-900">{formatPercent(row.reopenRate)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Median days to reopen</div>
                    <div className="mt-1 font-semibold text-gray-900">{formatDays(row.medianDaysToReopen)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Average days to durable closure</div>
                    <div className="mt-1 font-semibold text-gray-900">{formatDays(row.averageDaysToDurableClose)}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <InterventionEffectivenessReasonTable title="Resolve Reason Performance" rows={props.resolveReasonPerformance} />
            <InterventionEffectivenessReasonTable title="Snooze Reason Performance" rows={props.snoozeReasonPerformance} />
            <InterventionEffectivenessReasonTable
              title="Escalation Reason Performance"
              rows={props.escalationReasonPerformance}
            />
            <InterventionEffectivenessReasonTable
              title="Escalation Target Performance"
              rows={props.escalationTargetPerformance}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <Card className="border-border/70 shadow-none">
              <CardHeader>
                <CardTitle>Disconnect-Type Interactions</CardTitle>
              </CardHeader>
              <CardContent>
                {props.disconnectTypeInteractions.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    No interaction rows yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {props.disconnectTypeInteractions.map((row) => (
                      <Link
                        key={`${row.disconnectType}:${row.conclusionFamily}`}
                        to={row.queueLink}
                        className="block rounded-lg border border-border/70 px-4 py-3 transition-colors hover:border-brand-red/40 hover:bg-muted/20"
                      >
                        <div className="font-medium text-gray-900">
                          {row.disconnectType.replace(/_/g, " ")} · {row.conclusionFamily}
                        </div>
                        <div className="mt-2 text-sm text-muted-foreground">
                          {row.volume} conclusions · durable close {formatPercent(row.durableCloseRate)} · reopen{" "}
                          {formatPercent(row.reopenRate)}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 shadow-none">
              <CardHeader>
                <CardTitle>Assignee Effectiveness</CardTitle>
              </CardHeader>
              <CardContent>
                {props.assigneeEffectiveness.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    No assignee effectiveness rows yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {props.assigneeEffectiveness.map((row) => {
                      const content = (
                        <>
                          <div className="font-medium text-gray-900">{row.assigneeName ?? "Unassigned"}</div>
                          <div className="mt-2 text-sm text-muted-foreground">
                            {row.volume} conclusions · resolve {row.resolveCount} · snooze {row.snoozeCount} · escalate{" "}
                            {row.escalateCount}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            Durable close {formatPercent(row.durableCloseRate)} · reopen {formatPercent(row.reopenRate)}
                          </div>
                        </>
                      );

                      return row.queueLink ? (
                        <Link
                          key={row.assigneeId ?? "unassigned"}
                          to={row.queueLink}
                          className="block rounded-lg border border-border/70 px-4 py-3 transition-colors hover:border-brand-red/40 hover:bg-muted/20"
                        >
                          {content}
                        </Link>
                      ) : (
                        <div
                          key={row.assigneeId ?? "unassigned"}
                          className="rounded-lg border border-border/70 px-4 py-3"
                        >
                          {content}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <InterventionEffectivenessWarnings warnings={props.warnings} />
        </CardContent>
      </Card>
    </div>
  );
}
