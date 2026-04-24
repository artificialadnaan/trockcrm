import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Building2, MapPin, Clock3, User, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LeadForm } from "@/components/leads/lead-form";
import { LeadConvertDialog } from "@/components/leads/lead-convert-dialog";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { formatLeadPropertyLine, getLeadStageMetadata, useLeadDetail } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { isBidBoardMirroredStageSlug } from "@/lib/pipeline-ownership";

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { lead, loading, error } = useLeadDetail(id);
  const { stages } = usePipelineStages();
  const [isConvertDialogOpen, setIsConvertDialogOpen] = useState(false);

  const currentStage = useMemo(
    () => stages.find((stage) => stage.id === lead?.stageId) ?? null,
    [lead?.stageId, stages]
  );
  const currentStageMeta = useMemo(
    () => (lead ? getLeadStageMetadata(lead.stageId, stages) : null),
    [lead, stages]
  );
  const isConverted = lead?.status === "converted" || Boolean(lead?.convertedDealId);
  const convertedAt = lead?.convertedAt ?? null;

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
  const currentStageSlug = currentStageMeta?.slug ?? null;
  const isOpportunityStage = currentStageSlug === "opportunity";
  const isBidBoardMirrorStage = isBidBoardMirroredStageSlug(currentStageSlug);
  const canConvertToOpportunity =
    !isConverted &&
    (currentStageSlug === "sales_validation_stage" || currentStageSlug === "opportunity");

  const secondaryAction = !isConverted
    ? {
        label: currentStageSlug === "sales_validation_stage" ? "Edit Sales Validation" : "Edit Lead",
        onClick: () => navigate(`/leads/${lead.id}/edit`),
      }
    : lead.convertedDealId && isOpportunityStage
      ? {
          label: "Open Opportunity Scope",
          onClick: () => navigate(`/deals/${lead.convertedDealId}?tab=scoping`),
        }
      : lead.convertedDealId
        ? {
            label: "Open Read-Only Deal",
            onClick: () => navigate(`/deals/${lead.convertedDealId}`),
          }
        : null;

  const contextTitle = isOpportunityStage
    ? "Opportunity Scope"
    : isBidBoardMirrorStage
      ? "Bid Board Mirror"
      : "Lead context";
  const contextMessage = !isConverted
    ? "This record is still on the lead side of the workflow. Sales Validation is the last lead checkpoint before promotion into an Opportunity."
    : isOpportunityStage
      ? "Opportunity is still CRM-owned before estimating handoff."
      : isBidBoardMirrorStage
        ? "Downstream deal state is mirrored from Bid Board and read-only in CRM after estimating starts."
        : "This lead has already been promoted into an Opportunity. Pre-conversion history stays here, while scoping now lives in the deal record.";
  const contextFootnote = isOpportunityStage
    ? "Sales can still update scope, route, and qualification details in CRM at this stage."
    : isBidBoardMirrorStage
      ? "Use the deal record for meeting context, but do not expect manual CRM stage edits to stick downstream."
      : null;

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
              <LeadStageBadge stageId={lead.stageId} converted={isConverted} />
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

          <LeadTimelineTab leadId={lead.id} convertedDealId={lead.convertedDealId} convertedAt={convertedAt} />
        </div>

        <div className="space-y-4">
          <LeadForm
            showPrimaryAction={false}
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
              projectTypeId: lead.projectTypeId,
              projectType: lead.projectType,
              qualificationPayload: lead.qualificationPayload,
              projectTypeQuestionPayload: lead.projectTypeQuestionPayload,
              stageEnteredAt: lead.stageEnteredAt,
            }}
            converted={isConverted}
          />

          {canConvertToOpportunity ? (
            <>
              <Button onClick={() => setIsConvertDialogOpen(true)}>Convert to Opportunity</Button>
              <LeadConvertDialog
                lead={lead}
                open={isConvertDialogOpen}
                onOpenChange={setIsConvertDialogOpen}
                onSuccess={(dealId) => navigate(`/deals/${dealId}?tab=scoping`)}
              />
            </>
          ) : null}

          {secondaryAction && (
            <Button variant="outline" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">{contextTitle}</p>
              </div>
              <p className="text-sm text-muted-foreground">{contextMessage}</p>
              {contextFootnote && <p className="text-xs text-muted-foreground">{contextFootnote}</p>}
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" />
                <span>{lead.primaryContactId ? "Primary contact linked" : "No primary contact yet"}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Phone className="h-4 w-4" />
                <span>{lead.lastActivityAt ? "Activity recorded" : "No activity yet"}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
