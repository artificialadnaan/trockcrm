import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ArrowRight, Building2, GripVertical, MapPin, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import {
  formatLeadPropertyLine,
  transitionLeadStage,
  useLeads,
  type LeadRecord,
  type LeadTransitionInlinePatch,
  type LeadTransitionMissingRequirement,
} from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

type MissingFormDraft = {
  source: string;
  description: string;
  qualificationScope: string;
  qualificationBudgetAmount: string;
  qualificationCompanyFit: boolean;
  directorReviewDecision: "" | "go" | "no_go";
  directorReviewReason: string;
};

export function isImmediateNextStageMove(
  currentStageId: string,
  targetStageId: string,
  nextStageById: Map<string, string | null>
) {
  return nextStageById.get(currentStageId) === targetStageId;
}

export function isValidDirectorDecisionForTarget(
  targetStageSlug: string | undefined,
  decision: MissingFormDraft["directorReviewDecision"]
) {
  if (targetStageSlug === "ready_for_opportunity") return decision === "go";
  return decision === "go" || decision === "no_go";
}

function buildMissingDraft(lead: LeadRecord): MissingFormDraft {
  return {
    source: lead.source ?? "",
    description: lead.description ?? "",
    qualificationScope: lead.qualificationScope ?? "",
    qualificationBudgetAmount: lead.qualificationBudgetAmount ?? "",
    qualificationCompanyFit: lead.qualificationCompanyFit === true,
    directorReviewDecision: lead.directorReviewDecision ?? "",
    directorReviewReason: lead.directorReviewReason ?? "",
  };
}

function applyInlinePatchToDraft(
  draft: MissingFormDraft,
  inlinePatch?: LeadTransitionInlinePatch
): MissingFormDraft {
  if (!inlinePatch) return draft;
  const next = { ...draft };
  if (inlinePatch.source !== undefined) next.source = inlinePatch.source ?? "";
  if (inlinePatch.description !== undefined) next.description = inlinePatch.description ?? "";
  if (inlinePatch.qualificationScope !== undefined) next.qualificationScope = inlinePatch.qualificationScope ?? "";
  if (inlinePatch.qualificationBudgetAmount !== undefined) {
    next.qualificationBudgetAmount = inlinePatch.qualificationBudgetAmount ?? "";
  }
  if (inlinePatch.qualificationCompanyFit !== undefined) {
    next.qualificationCompanyFit = inlinePatch.qualificationCompanyFit === true;
  }
  if (inlinePatch.directorReviewDecision !== undefined) {
    next.directorReviewDecision = inlinePatch.directorReviewDecision ?? "";
  }
  if (inlinePatch.directorReviewReason !== undefined) {
    next.directorReviewReason = inlinePatch.directorReviewReason ?? "";
  }
  return next;
}

function LeadKanbanCard({
  lead,
  canAdvance,
  onAdvance,
  isDragging = false,
}: {
  lead: LeadRecord;
  canAdvance: boolean;
  onAdvance: (lead: LeadRecord) => void;
  isDragging?: boolean;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: lead.id,
    data: { lead },
  });

  const style = transform
    ? {
        transform: `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`,
      }
    : undefined;

  const companyName = lead.companyName ?? "Unassigned";
  const propertyLine = formatLeadPropertyLine(lead);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`p-4 transition-colors ${isDragging ? "opacity-60 shadow-lg" : "hover:bg-muted/40"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {lead.convertedDealNumber && (
              <span className="font-mono text-xs text-muted-foreground">{lead.convertedDealNumber}</span>
            )}
            <LeadStageBadge stageId={lead.stageId} />
          </div>
          <button
            type="button"
            className="w-full truncate text-left text-lg font-semibold hover:underline"
            onClick={() => navigate(`/leads/${lead.id}`)}
          >
            {lead.name}
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span>{companyName}</span>
            {propertyLine && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {propertyLine}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="rounded border p-1 text-muted-foreground hover:text-foreground"
          aria-label="Drag lead card"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="outline" disabled={!canAdvance} onClick={() => onAdvance(lead)}>
          Move Next
        </Button>
      </div>
    </Card>
  );
}

function LeadStageColumn({
  stageId,
  stageName,
  leads,
  activeLeadId,
  canAdvance,
  onAdvance,
}: {
  stageId: string;
  stageName: string;
  leads: LeadRecord[];
  activeLeadId: string | null;
  canAdvance: (lead: LeadRecord) => boolean;
  onAdvance: (lead: LeadRecord) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stageId });

  return (
    <div
      ref={setNodeRef}
      className={`flex h-full min-h-[28rem] w-80 flex-shrink-0 flex-col rounded-xl border bg-card ${
        isOver ? "ring-2 ring-brand-red/40" : ""
      }`}
    >
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{stageName}</p>
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-semibold">{leads.length}</span>
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {leads.map((lead) => (
          <LeadKanbanCard
            key={lead.id}
            lead={lead}
            canAdvance={canAdvance(lead)}
            onAdvance={onAdvance}
            isDragging={activeLeadId === lead.id}
          />
        ))}
        {leads.length === 0 && (
          <div className="rounded border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
            No leads in this stage
          </div>
        )}
      </div>
    </div>
  );
}

export function LeadListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const { leads, loading, error, refetch } = useLeads();
  const { stages } = usePipelineStages();
  const [activeLead, setActiveLead] = useState<LeadRecord | null>(null);
  const [transitionSaving, setTransitionSaving] = useState(false);
  const [missingDialog, setMissingDialog] = useState<{
    lead: LeadRecord;
    targetStageId: string;
    targetStageName: string;
    missing: LeadTransitionMissingRequirement[];
    draft: MissingFormDraft;
  } | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const bucket = searchParams.get("bucket");

  const leadStages = useMemo(
    () =>
      stages
        .filter((stage) => stage.workflowFamily === "lead")
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [stages]
  );

  const stageById = useMemo(() => new Map(leadStages.map((stage) => [stage.id, stage])), [leadStages]);
  const nextStageById = useMemo(() => {
    const map = new Map<string, string | null>();
    leadStages.forEach((stage, index) => {
      map.set(stage.id, leadStages[index + 1]?.id ?? null);
    });
    return map;
  }, [leadStages]);

  const filteredLeads = useMemo(() => {
    const query = search.trim().toLowerCase();
    const bucketFiltered = leads.filter((lead) => {
      const stageSlug = stageById.get(lead.stageId)?.slug;
      if (bucket === "lead") return stageSlug === "contacted";
      if (bucket === "qualified_lead") return stageSlug === "qualified_lead";
      if (bucket === "opportunity") {
        return stageSlug === "director_go_no_go" || stageSlug === "ready_for_opportunity";
      }
      return true;
    });

    if (!query) return bucketFiltered;
    return bucketFiltered.filter((lead) => {
      const haystack = [
        lead.name,
        lead.companyName,
        lead.source,
        lead.property?.name,
        lead.property?.address,
        lead.property?.city,
        lead.property?.state,
        lead.property?.zip,
        lead.convertedDealNumber,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [bucket, leads, search, stageById]);

  const leadsByStageId = useMemo(() => {
    const map = new Map<string, LeadRecord[]>();
    for (const stage of leadStages) map.set(stage.id, []);
    for (const lead of filteredLeads) {
      if (!map.has(lead.stageId)) map.set(lead.stageId, []);
      map.get(lead.stageId)!.push(lead);
    }
    return map;
  }, [filteredLeads, leadStages]);

  const applyTransition = async (
    lead: LeadRecord,
    targetStageId: string,
    inlinePatch?: LeadTransitionInlinePatch
  ) => {
    setTransitionSaving(true);
    try {
      const result = await transitionLeadStage(lead.id, { targetStageId, inlinePatch });
      if (result.ok) {
        toast.success("Lead moved to next stage");
        setMissingDialog(null);
        await refetch();
        return;
      }

      const targetStage = stageById.get(targetStageId);
      const previousDraft =
        missingDialog && missingDialog.lead.id === lead.id && missingDialog.targetStageId === targetStageId
          ? missingDialog.draft
          : buildMissingDraft(lead);
      setMissingDialog({
        lead,
        targetStageId,
        targetStageName: targetStage?.name ?? "Next stage",
        missing: result.missing,
        draft: applyInlinePatchToDraft(previousDraft, inlinePatch),
      });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to move lead");
    } finally {
      setTransitionSaving(false);
    }
  };

  const handleMoveNext = async (lead: LeadRecord) => {
    const targetStageId = nextStageById.get(lead.stageId);
    if (!targetStageId) {
      toast.error("Lead is already at the last stage before conversion");
      return;
    }
    await applyTransition(lead, targetStageId);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveLead((event.active.data.current?.lead as LeadRecord) ?? null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveLead(null);
    const lead = (event.active.data.current?.lead as LeadRecord) ?? null;
    const targetStageId = event.over?.id ? String(event.over.id) : null;
    if (!lead || !targetStageId || lead.stageId === targetStageId) return;

    const currentStage = stageById.get(lead.stageId);
    const targetStage = stageById.get(targetStageId);
    if (!currentStage || !targetStage) return;

    if (!isImmediateNextStageMove(lead.stageId, targetStageId, nextStageById)) {
      toast.error("Leads can only move one stage forward at a time");
      return;
    }

    await applyTransition(lead, targetStageId);
  };

  const canAdvance = (lead: LeadRecord) => Boolean(nextStageById.get(lead.stageId));

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 animate-pulse rounded bg-muted" />
        <div className="flex gap-3 overflow-x-auto">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-[28rem] w-80 flex-shrink-0 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-brand-red" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-brand-red">Lead Pipeline</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">Leads</h1>
          <p className="text-sm text-muted-foreground">{filteredLeads.length} lead{filteredLeads.length !== 1 ? "s" : ""}</p>
        </div>
        <Button onClick={() => navigate("/leads/new")}>
          <Plus className="mr-2 h-4 w-4" />
          New Lead
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search leads, companies, or properties..."
            className="pl-9"
          />
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {leadStages.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Lead pipeline stages are not configured yet.
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={(event) => void handleDragEnd(event)}>
          <div className="overflow-x-auto pb-2">
            <div className="flex min-h-[28rem] gap-3">
              {leadStages.map((stage) => (
                <LeadStageColumn
                  key={stage.id}
                  stageId={stage.id}
                  stageName={stage.name}
                  leads={leadsByStageId.get(stage.id) ?? []}
                  activeLeadId={activeLead?.id ?? null}
                  canAdvance={canAdvance}
                  onAdvance={(lead) => void handleMoveNext(lead)}
                />
              ))}
            </div>
          </div>

          <DragOverlay>
            {activeLead ? <LeadKanbanCard lead={activeLead} canAdvance={canAdvance(activeLead)} onAdvance={() => {}} isDragging /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <Dialog
        open={missingDialog !== null}
        onOpenChange={(open) => {
          if (!open) setMissingDialog(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Complete Required Fields</DialogTitle>
            <DialogDescription>
              Fill the required lead fields before moving to {missingDialog?.targetStageName ?? "the next stage"}.
            </DialogDescription>
          </DialogHeader>

          {missingDialog && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="font-medium">{missingDialog.lead.name}</p>
                <p className="text-muted-foreground">{missingDialog.missing.map((item) => item.label).join(", ")}</p>
              </div>

              {missingDialog.missing.some((item) => item.key === "source") && (
                <div className="space-y-1.5">
                  <Label htmlFor="lead-source">Lead source</Label>
                  <Input
                    id="lead-source"
                    value={missingDialog.draft.source}
                    onChange={(event) =>
                      setMissingDialog((current) =>
                        current ? { ...current, draft: { ...current.draft, source: event.target.value } } : current
                      )
                    }
                  />
                </div>
              )}

              {missingDialog.missing.some((item) => item.key === "description") && (
                <div className="space-y-1.5">
                  <Label htmlFor="lead-description">Description</Label>
                  <Textarea
                    id="lead-description"
                    value={missingDialog.draft.description}
                    onChange={(event) =>
                      setMissingDialog((current) =>
                        current ? { ...current, draft: { ...current.draft, description: event.target.value } } : current
                      )
                    }
                  />
                </div>
              )}

              {missingDialog.missing.some((item) => item.key === "qualificationScope") && (
                <div className="space-y-1.5">
                  <Label htmlFor="lead-qualification-scope">Scope</Label>
                  <Input
                    id="lead-qualification-scope"
                    value={missingDialog.draft.qualificationScope}
                    onChange={(event) =>
                      setMissingDialog((current) =>
                        current
                          ? { ...current, draft: { ...current.draft, qualificationScope: event.target.value } }
                          : current
                      )
                    }
                  />
                </div>
              )}

              {missingDialog.missing.some((item) => item.key === "qualificationBudgetAmount") && (
                <div className="space-y-1.5">
                  <Label htmlFor="lead-qualification-budget">Budget</Label>
                  <Input
                    id="lead-qualification-budget"
                    value={missingDialog.draft.qualificationBudgetAmount}
                    onChange={(event) =>
                      setMissingDialog((current) =>
                        current
                          ? { ...current, draft: { ...current.draft, qualificationBudgetAmount: event.target.value } }
                          : current
                      )
                    }
                  />
                </div>
              )}

              {missingDialog.missing.some((item) => item.key === "qualificationCompanyFit") && (
                <label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <Checkbox
                    checked={missingDialog.draft.qualificationCompanyFit}
                    onCheckedChange={(checked) =>
                      setMissingDialog((current) =>
                        current
                          ? { ...current, draft: { ...current.draft, qualificationCompanyFit: checked === true } }
                          : current
                      )
                    }
                  />
                  Company fit confirmed
                </label>
              )}

              {missingDialog.missing.some((item) => item.key === "directorReviewDecision") && (
                <div className="space-y-1.5">
                  <Label htmlFor="lead-director-review">Director decision</Label>
                  <select
                    id="lead-director-review"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={missingDialog.draft.directorReviewDecision}
                    onChange={(event) =>
                      setMissingDialog((current) =>
                        current
                          ? {
                              ...current,
                              draft: {
                                ...current.draft,
                                directorReviewDecision: event.target.value as MissingFormDraft["directorReviewDecision"],
                              },
                            }
                          : current
                      )
                    }
                  >
                    <option value="">Select decision</option>
                    <option value="go">Go</option>
                    {stageById.get(missingDialog.targetStageId)?.slug !== "ready_for_opportunity" && (
                      <option value="no_go">No Go</option>
                    )}
                  </select>
                  {stageById.get(missingDialog.targetStageId)?.slug === "ready_for_opportunity" && (
                    <p className="text-xs text-muted-foreground">
                      This transition only accepts a Go decision.
                    </p>
                  )}
                </div>
              )}

              {missingDialog.missing.some((item) => item.key === "directorReviewReason") && (
                <div className="space-y-1.5">
                  <Label htmlFor="lead-director-reason">Director reason</Label>
                  <Textarea
                    id="lead-director-reason"
                    value={missingDialog.draft.directorReviewReason}
                    onChange={(event) =>
                      setMissingDialog((current) =>
                        current
                          ? { ...current, draft: { ...current.draft, directorReviewReason: event.target.value } }
                          : current
                      )
                    }
                  />
                </div>
              )}

              {missingDialog.missing.some((item) => item.resolution === "detail") && (
                <p className="text-sm text-muted-foreground">
                  Some requirements require edits in the lead detail page. Open the lead to complete linked requirements.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={transitionSaving} onClick={() => setMissingDialog(null)}>
              Cancel
            </Button>
            {missingDialog?.missing.some((item) => item.resolution === "inline") ? (
              <Button
                disabled={transitionSaving || missingDialog == null}
                onClick={async () => {
                  if (!missingDialog) return;
                  const missingKeys = new Set(
                    missingDialog.missing
                      .filter((item) => item.resolution === "inline")
                      .map((item) => item.key)
                  );
                  const inlinePatch: Parameters<typeof transitionLeadStage>[1]["inlinePatch"] = {};
                  const targetSlug = stageById.get(missingDialog.targetStageId)?.slug;

                  if (missingKeys.has("source")) inlinePatch.source = missingDialog.draft.source;
                  if (missingKeys.has("description")) inlinePatch.description = missingDialog.draft.description;
                  if (missingKeys.has("qualificationScope")) {
                    inlinePatch.qualificationScope = missingDialog.draft.qualificationScope;
                  }
                  if (missingKeys.has("qualificationBudgetAmount")) {
                    inlinePatch.qualificationBudgetAmount = missingDialog.draft.qualificationBudgetAmount;
                  }
                  if (missingKeys.has("qualificationCompanyFit")) {
                    inlinePatch.qualificationCompanyFit = missingDialog.draft.qualificationCompanyFit;
                  }
                  if (missingKeys.has("directorReviewDecision") && missingDialog.draft.directorReviewDecision) {
                    if (
                      !isValidDirectorDecisionForTarget(
                        targetSlug,
                        missingDialog.draft.directorReviewDecision
                      )
                    ) {
                      toast.error("Ready for opportunity requires a Go decision.");
                      return;
                    }
                    inlinePatch.directorReviewDecision = missingDialog.draft.directorReviewDecision;
                  }
                  if (missingKeys.has("directorReviewReason")) {
                    inlinePatch.directorReviewReason = missingDialog.draft.directorReviewReason;
                  }

                  await applyTransition(missingDialog.lead, missingDialog.targetStageId, inlinePatch);
                }}
              >
                {transitionSaving ? "Saving..." : "Save and Move"}
              </Button>
            ) : null}
            {missingDialog && (
              <Button variant="ghost" disabled={transitionSaving} onClick={() => navigate(`/leads/${missingDialog.lead.id}`)}>
                Open Lead
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
