import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Building2, MapPin, Clock3, User, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RecordAssignmentCard } from "@/components/assignment/record-assignment-card";
import { LeadForm } from "@/components/leads/lead-form";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { ForecastEditor } from "@/components/shared/forecast-editor";
import { NextStepEditor } from "@/components/shared/next-step-editor";
import { LeadQualificationPanel } from "@/components/leads/lead-qualification-panel";
import { LeadScopingWorkspace } from "@/components/leads/lead-scoping-workspace";
import { LeadStageChangeDialog } from "@/components/leads/lead-stage-change-dialog";
import { LeadConvertDialog } from "@/components/leads/lead-convert-dialog";
import { formatLeadPropertyLine, updateLead, useLeadDetail } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { useAuth } from "@/lib/auth";
import { useTaskAssignees } from "@/hooks/use-task-assignees";

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { lead, loading, error, refetch } = useLeadDetail(id);
  const { stages } = usePipelineStages();
  const { assignees: availableReps } = useTaskAssignees();
  const [savingAssignment, setSavingAssignment] = useState(false);
  const [targetStageId, setTargetStageId] = useState<string | null>(null);
  const [stageDialogOpen, setStageDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);

  const currentStage = useMemo(
    () => stages.find((stage) => stage.id === lead?.stageId) ?? null,
    [lead?.stageId, stages]
  );
  const isConvertedLead = Boolean(lead?.convertedAt || lead?.convertedDealId || lead?.status === "converted");
  const isLeadStage = currentStage?.workflowFamily === "lead" && !isConvertedLead;
  const convertedAt = lead?.convertedAt ?? null;
  const leadStages = useMemo(
    () =>
      stages
        .filter((stage) => stage.workflowFamily === "lead")
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [stages]
  );
  const nextLeadStage = useMemo(() => {
    if (!currentStage || !isLeadStage) {
      return null;
    }

    return leadStages.find((stage) => stage.displayOrder > currentStage.displayOrder) ?? null;
  }, [currentStage, isLeadStage, leadStages]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-44 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error || !lead) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Lead not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/leads")}>
          Back to Leads
        </Button>
      </div>
    );
  }

  const leadCompanyName = lead.companyName ?? null;
  const propertyLine = formatLeadPropertyLine(lead);
  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";
  const assignedRepName =
    availableReps.find((assignee) => assignee.id === lead.assignedRepId)?.displayName ??
    lead.assignedRepId;
  const canConvertToOpportunity =
    currentStage?.slug === "qualified_for_opportunity" && !lead.convertedDealId && !isConvertedLead;
  const qualificationFocused = searchParams.get("focus") === "qualification";
  const scopingFocused = searchParams.get("focus") === "scoping";

  const handleAssignmentSave = async (assignedRepId: string) => {
    if (assignedRepId === lead.assignedRepId) return;
    setSavingAssignment(true);
    try {
      await updateLead(lead.id, { assignedRepId });
      await refetch();
    } finally {
      setSavingAssignment(false);
    }
  };

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground hover:text-foreground"
        onClick={() => navigate("/leads")}
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Leads
      </Button>

      <div className="grid gap-6 lg:grid-cols-[1.35fr_0.9fr]">
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-mono uppercase tracking-[0.18em] text-muted-foreground">
                {lead.convertedDealNumber ?? lead.id.slice(0, 8)}
              </span>
              <LeadStageBadge stageId={lead.stageId} converted={isConvertedLead} />
            </div>
            <h1 className="text-4xl font-black tracking-tight text-foreground">{lead.name}</h1>
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Building2 className="h-4 w-4" />
                {leadCompanyName ?? "Unassigned company"}
              </span>
              {propertyLine && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {propertyLine}
                </span>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Stage</p>
                <p className="mt-2 text-sm font-semibold">{currentStage?.name ?? "Lead"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Activity</p>
                <p className="mt-2 text-sm font-semibold">Inherited into deal timeline</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
                <p className="mt-2 text-sm font-semibold">
                  {new Date(lead.updatedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </CardContent>
            </Card>
          </div>

          <ForecastEditor
            value={{
              forecastWindow: lead.forecastWindow,
              forecastCategory: lead.forecastCategory,
              forecastConfidencePercent: lead.forecastConfidencePercent,
              forecastRevenue: lead.forecastRevenue,
              forecastGrossProfit: lead.forecastGrossProfit,
              forecastBlockers: lead.forecastBlockers,
              nextMilestoneAt: lead.nextMilestoneAt,
            }}
            onSave={async (payload) => {
              await updateLead(lead.id, payload);
              await refetch();
            }}
          />

          <NextStepEditor
            value={{
              nextStep: lead.nextStep,
              nextStepDueAt: lead.nextStepDueAt,
              supportNeededType: lead.supportNeededType,
              supportNeededNotes: lead.supportNeededNotes,
              decisionMakerName: lead.decisionMakerName,
              budgetStatus: lead.budgetStatus,
            }}
            onSave={async (payload) => {
              await updateLead(lead.id, payload);
              await refetch();
            }}
          />

          <LeadTimelineTab leadId={lead.id} convertedDealId={lead.convertedDealId} convertedAt={convertedAt} />
        </div>

        <div className="space-y-4">
          <RecordAssignmentCard
            label="Assigned Rep"
            assignedRepId={lead.assignedRepId}
            assignedRepName={assignedRepName}
            reps={availableReps}
            canEdit={isDirectorOrAdmin}
            saving={savingAssignment}
            onSave={handleAssignmentSave}
          />

          <LeadForm
            lead={{
              id: lead.id,
              name: lead.name,
              convertedDealId: lead.convertedDealId,
              convertedDealNumber: lead.convertedDealNumber,
              companyId: lead.companyId ?? null,
              companyName: leadCompanyName,
              stageId: lead.stageId,
              propertyId: lead.propertyId,
              propertyName: lead.property?.name ?? null,
              propertyAddress: lead.property?.address ?? null,
              propertyCity: lead.property?.city ?? null,
              propertyState: lead.property?.state ?? null,
              propertyZip: lead.property?.zip ?? null,
              source: lead.source,
              description: lead.description,
              stageEnteredAt: lead.stageEnteredAt,
            }}
            converted={isConvertedLead}
            showPrimaryAction={false}
          />

          {isLeadStage && (
            <div className="space-y-3">
              {qualificationFocused || scopingFocused ? (
                <Card className="border-brand-red/30 bg-brand-red/5">
                  <CardContent className="space-y-1 pt-4">
                    <p className="text-sm font-semibold text-foreground">
                      {scopingFocused ? "Complete Lead Scoping Checklist" : "Complete Qualification Intake"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {scopingFocused
                        ? "Complete the lead scoping checklist below before moving this lead into Lead Go/No-Go."
                        : "Complete the qualification intake below to satisfy the current stage requirements."}
                    </p>
                  </CardContent>
                </Card>
              ) : null}
              <LeadQualificationPanel
                leadId={lead.id}
                onSaved={() => {
                  void refetch();
                }}
              />
              <LeadScopingWorkspace
                leadId={lead.id}
                onSaved={() => {
                  void refetch();
                }}
              />
            </div>
          )}

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Lead context</p>
              </div>
              <p className="text-sm text-muted-foreground">
                {isConvertedLead
                  ? "This lead has already been converted, but the pre-RFP history remains available here."
                  : isLeadStage
                    ? "This record is still in the lead stage. Converting it moves the work into the deal pipeline."
                    : "This lead is in a downstream workflow stage. Use the linked deal to continue opportunity work."}
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" />
                <span>{lead.primaryContactId ? "Primary contact linked" : "No primary contact yet"}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Phone className="h-4 w-4" />
                <span>{lead.lastActivityAt ? "Activity recorded" : "No activity yet"}</span>
              </div>
              {isLeadStage && nextLeadStage && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setTargetStageId(nextLeadStage.id);
                    setStageDialogOpen(true);
                  }}
                >
                  Advance to {nextLeadStage.name}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              {canConvertToOpportunity && (
                <Button className="w-full" onClick={() => setConvertDialogOpen(true)}>
                  Convert to Opportunity
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              {lead.convertedDealId && (
                <Button className="w-full" onClick={() => navigate(`/deals/${lead.convertedDealId}`)}>
                  Open Deal
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <>
        <LeadStageChangeDialog
          lead={lead}
          targetStageId={targetStageId}
          open={stageDialogOpen}
          onOpenChange={setStageDialogOpen}
          onSuccess={() => {
            setStageDialogOpen(false);
            setTargetStageId(null);
            void refetch();
          }}
        />
        <LeadConvertDialog
          lead={lead}
          open={convertDialogOpen}
          onOpenChange={setConvertDialogOpen}
          onSuccess={(dealId) => navigate(`/deals/${dealId}?enrichment=1`)}
        />
      </>
    </div>
  );
}
