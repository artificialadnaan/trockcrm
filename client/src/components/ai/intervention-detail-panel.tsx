import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { InterventionMutationResult } from "@/hooks/use-admin-interventions";
import {
  assignIntervention,
  escalateIntervention,
  resolveIntervention,
  snoozeIntervention,
  summarizeInterventionMutationResult,
  toLocalDateTimeInput,
  useAdminInterventionDetail,
} from "@/hooks/use-admin-interventions";
import type {
  EscalateConclusionPayload,
  ResolveConclusionPayload,
  SnoozeConclusionPayload,
} from "@/lib/intervention-outcome-taxonomy";
import { InterventionConclusionForm } from "@/components/ai/intervention-conclusion-form";
import { InterventionCaseCopilotPanel } from "@/components/ai/intervention-case-copilot-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

function formatDate(value: string | null) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

function normalizeInterventionSummaryMessage(message: string) {
  return message.replace(/\.\.\s+/g, ". ");
}

export function getInterventionDetailMutationOutcome(result: InterventionMutationResult) {
  const summary = summarizeInterventionMutationResult(result);
  return {
    summary: {
      ...summary,
      message: normalizeInterventionSummaryMessage(summary.message),
    },
    shouldRefreshDetail: result.updatedCount > 0,
    shouldClearNotes: result.updatedCount > 0,
  };
}

export function InterventionDetailPanel(props: {
  caseId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const { detail, loading, error, refetch } = useAdminInterventionDetail(props.caseId);
  const [assignedTo, setAssignedTo] = useState("");
  const [workingAction, setWorkingAction] = useState<string | null>(null);
  const [formResetKey, setFormResetKey] = useState(0);

  useEffect(() => {
    setAssignedTo(detail?.case.assignedTo ?? "");
  }, [detail?.case.id]);

  async function runAction(action: string, work: () => Promise<InterventionMutationResult>) {
    setWorkingAction(action);
    try {
      const result = await work();
      const outcome = getInterventionDetailMutationOutcome(result);
      toast[outcome.summary.tone](outcome.summary.message);
      if (outcome.shouldRefreshDetail) {
        await refetch();
        if (outcome.shouldClearNotes) setFormResetKey((current) => current + 1);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update intervention case");
    } finally {
      await props.onUpdated();
      setWorkingAction(null);
    }
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Intervention Case</SheetTitle>
          <SheetDescription>
            Review disconnect evidence, generated-task state, and direct admin actions without leaving the workspace.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-5">
          {loading && <div className="text-sm text-muted-foreground">Loading intervention detail...</div>}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {detail && (
            <>
              <div className="rounded-lg border border-border/80 bg-muted/30 p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{detail.case.disconnectType}</Badge>
                  <Badge variant="outline">{detail.case.status}</Badge>
                  <Badge variant="outline">{detail.case.severity}</Badge>
                  {detail.case.escalated && (
                    <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                      Escalated
                    </Badge>
                  )}
                </div>
                <div>
                  {detail.crm.deal ? (
                    <Link to={`/deals/${detail.crm.deal.id}`} className="text-base font-semibold text-brand-red hover:underline">
                      {detail.crm.deal.dealNumber} {detail.crm.deal.name}
                    </Link>
                  ) : (
                    <div className="text-base font-semibold">Unlinked disconnect case</div>
                  )}
                  {detail.crm.company && (
                    <div className="text-sm text-muted-foreground mt-1">
                      <Link to={`/companies/${detail.crm.company.id}`} className="hover:underline">
                        {detail.crm.company.name}
                      </Link>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-widest text-muted-foreground">Assigned to</div>
                    <div>{detail.case.assignedToName ?? detail.case.assignedTo ?? "Unassigned"}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest text-muted-foreground">Snoozed until</div>
                    <div>{formatDate(detail.case.snoozedUntil)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest text-muted-foreground">Last detected</div>
                    <div>{formatDate(detail.case.lastDetectedAt)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest text-muted-foreground">Reopen count</div>
                    <div>{detail.case.reopenCount}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border/80 bg-white p-4 space-y-3">
                <div className="text-sm font-semibold">Recommended execution artifact</div>
                {detail.generatedTask ? (
                  <div className="space-y-1 text-sm">
                    <div className="font-medium">{detail.generatedTask.title}</div>
                    <div className="text-muted-foreground">{detail.generatedTask.status}</div>
                    <div className="text-muted-foreground">
                      {detail.generatedTask.assignedToName ?? detail.generatedTask.assignedTo ?? "No task assignee"}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No generated task is currently linked to this case.</div>
                )}
              </div>

              <InterventionCaseCopilotPanel caseId={detail.case.id} />

              <div className="rounded-lg border border-border/80 bg-white p-4 space-y-4">
                <div className="text-sm font-semibold">Direct actions</div>
                <div className="space-y-2">
                  <Label htmlFor="detail-assigned-to">Assign to</Label>
                  <Input
                    id="detail-assigned-to"
                    placeholder="User UUID"
                    value={assignedTo}
                    onChange={(event) => setAssignedTo(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={workingAction !== null || assignedTo.trim().length === 0}
                    onClick={() =>
                      void runAction("assign", () =>
                        assignIntervention(detail.case.id, { assignedTo: assignedTo.trim(), notes: null })
                      )
                    }
                  >
                    {workingAction === "assign" ? "Saving..." : "Assign case"}
                  </Button>
                </div>

                <div className="rounded-lg border border-border/70 p-4">
                  <InterventionConclusionForm
                    mode="snooze"
                    submitLabel={workingAction === "snooze" ? "Saving..." : "Snooze case"}
                    disabled={workingAction !== null}
                    resetKey={`detail-snooze-${detail.case.id}-${formResetKey}`}
                    initialSnoozedUntil={toLocalDateTimeInput(detail.case.snoozedUntil)}
                    onSubmit={(payload) =>
                      runAction("snooze", () =>
                        snoozeIntervention(detail.case.id, { conclusion: payload as SnoozeConclusionPayload })
                      )
                    }
                  />
                </div>

                <div className="rounded-lg border border-border/70 p-4">
                  <InterventionConclusionForm
                    mode="resolve"
                    submitLabel={workingAction === "resolve" ? "Saving..." : "Resolve case"}
                    disabled={workingAction !== null}
                    resetKey={`detail-resolve-${detail.case.id}-${formResetKey}`}
                    onSubmit={(payload) =>
                      runAction("resolve", () =>
                        resolveIntervention(detail.case.id, { conclusion: payload as ResolveConclusionPayload })
                      )
                    }
                  />
                </div>

                <div className="rounded-lg border border-border/70 p-4">
                  <InterventionConclusionForm
                    mode="escalate"
                    submitLabel={workingAction === "escalate" ? "Saving..." : "Escalate case"}
                    disabled={workingAction !== null}
                    resetKey={`detail-escalate-${detail.case.id}-${formResetKey}`}
                    onSubmit={(payload) =>
                      runAction("escalate", () =>
                        escalateIntervention(detail.case.id, { conclusion: payload as EscalateConclusionPayload })
                      )
                    }
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border/80 bg-white p-4 space-y-3">
                <div className="text-sm font-semibold">Case history</div>
                {detail.history.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No intervention history yet.</div>
                ) : (
                  <div className="space-y-3">
                    {detail.history.map((entry) => (
                      <div key={entry.id} className="rounded-md border border-border/70 p-3 text-sm space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium">{entry.actionType}</div>
                          <div className="text-xs text-muted-foreground">{formatDate(entry.actedAt)}</div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {entry.fromStatus ?? "n/a"} → {entry.toStatus ?? "n/a"}
                        </div>
                        {entry.notes && <div className="leading-6">{entry.notes}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
