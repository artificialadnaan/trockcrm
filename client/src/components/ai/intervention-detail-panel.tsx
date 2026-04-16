import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { InterventionResolutionReason } from "@/hooks/use-admin-interventions";
import {
  INTERVENTION_RESOLUTION_OPTIONS,
  assignIntervention,
  escalateIntervention,
  resolveIntervention,
  snoozeIntervention,
  useAdminInterventionDetail,
} from "@/hooks/use-admin-interventions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

function formatDate(value: string | null) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

export function InterventionDetailPanel(props: {
  caseId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const { detail, loading, error, refetch } = useAdminInterventionDetail(props.caseId);
  const [assignedTo, setAssignedTo] = useState("");
  const [snoozedUntil, setSnoozedUntil] = useState("");
  const [resolutionReason, setResolutionReason] = useState<InterventionResolutionReason>("task_completed");
  const [notes, setNotes] = useState("");
  const [workingAction, setWorkingAction] = useState<string | null>(null);

  useEffect(() => {
    setAssignedTo(detail?.case.assignedTo ?? "");
    setSnoozedUntil(detail?.case.snoozedUntil ? detail.case.snoozedUntil.slice(0, 16) : "");
    setNotes("");
  }, [detail?.case.assignedTo, detail?.case.id, detail?.case.snoozedUntil]);

  async function runAction(action: string, work: () => Promise<unknown>) {
    setWorkingAction(action);
    try {
      await work();
      toast.success("Intervention case updated");
      await Promise.all([refetch(), props.onUpdated()]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update intervention case");
    } finally {
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
                    <div>{detail.case.assignedTo ?? "Unassigned"}</div>
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
                    <div className="text-muted-foreground">{detail.generatedTask.assignedTo ?? "No task assignee"}</div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No generated task is currently linked to this case.</div>
                )}
              </div>

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
                        assignIntervention(detail.case.id, { assignedTo: assignedTo.trim(), notes: notes.trim() || null })
                      )
                    }
                  >
                    {workingAction === "assign" ? "Saving..." : "Assign case"}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="detail-snoozed-until">Snooze until</Label>
                  <Input
                    id="detail-snoozed-until"
                    type="datetime-local"
                    value={snoozedUntil}
                    onChange={(event) => setSnoozedUntil(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={workingAction !== null || snoozedUntil.trim().length === 0}
                    onClick={() =>
                      void runAction("snooze", () =>
                        snoozeIntervention(detail.case.id, { snoozedUntil, notes: notes.trim() || null })
                      )
                    }
                  >
                    {workingAction === "snooze" ? "Saving..." : "Snooze case"}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="detail-resolution-reason">Resolve reason</Label>
                  <Select value={resolutionReason} onValueChange={(value) => setResolutionReason(value as InterventionResolutionReason)}>
                    <SelectTrigger id="detail-resolution-reason">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVENTION_RESOLUTION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={workingAction !== null}
                      onClick={() =>
                        void runAction("resolve", () =>
                          resolveIntervention(detail.case.id, {
                            resolutionReason,
                            notes: notes.trim() || null,
                          })
                        )
                      }
                    >
                      {workingAction === "resolve" ? "Saving..." : "Resolve case"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={workingAction !== null}
                      onClick={() =>
                        void runAction("escalate", () =>
                          escalateIntervention(detail.case.id, { notes: notes.trim() || null })
                        )
                      }
                    >
                      {workingAction === "escalate" ? "Saving..." : "Escalate case"}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="detail-notes">Notes</Label>
                  <Textarea
                    id="detail-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Capture what changed or why this action is appropriate."
                    rows={3}
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
