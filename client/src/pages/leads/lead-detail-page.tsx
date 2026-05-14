import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Building2,
  ClipboardList,
  Clock,
  Clock3,
  Edit,
  ExternalLink,
  FileText,
  Images,
  Mail,
  MapPin,
  Mic,
  Phone,
  User,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DetailPageShell,
  DetailRailItem,
  DetailRailSection,
  type DetailPageShellKpi,
  type DetailPageShellTab,
} from "@/components/layout/detail-page-shell";
import { LeadForm, LeadQuestionnaireSummary } from "@/components/leads/lead-form";
import { LeadConvertDialog } from "@/components/leads/lead-convert-dialog";
import { LeadStageChangeDialog } from "@/components/leads/lead-stage-change-dialog";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { LeadQuestionnaireEditor } from "@/components/leads/lead-questionnaire-editor";
import { RecordingList } from "@/components/call-recordings/recording-list";
import { LeadEmailTab } from "@/components/email/lead-email-tab";
import { LeadFileTab } from "@/components/files/lead-file-tab";
import { LeadPhotosTab } from "./lead-photos-tab";
import { formatLeadPropertyLine, getLeadStageMetadata, useLeadDetail } from "@/hooks/use-leads";
import type { LeadRecord } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { LEAD_BOARD_STAGE_SLUGS, isBidBoardMirroredStageSlug } from "@/lib/pipeline-ownership";
import { cn } from "@/lib/utils";
import { displayNameOrFallback } from "@/lib/display-identifiers";

type LeadDetailTab = "timeline" | "questionnaire" | "files" | "photos" | "emails" | "recordings";

function formatNullable(value: string | number | null | undefined) {
  if (value == null || value === "") return "Not set";
  return String(value);
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Not set";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function formatCurrency(value: string | number | null | undefined) {
  if (value == null || value === "") return "Unknown";
  const amount = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount)) return "Unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function daysSince(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function leadEstimatedValue(lead: LeadRecord) {
  const questionnaireEstimate = lead.qualificationPayload?.estimated_value;
  return lead.forecastRevenue ??
    lead.qualificationBudgetAmount ??
    (typeof questionnaireEstimate === "string" || typeof questionnaireEstimate === "number"
      ? questionnaireEstimate
      : null);
}

function sourceLabel(lead: LeadRecord) {
  return lead.sourceCategory ?? lead.source ?? lead.sourceDetail ?? null;
}

function ownerInitials(lead: LeadRecord) {
  return displayNameOrFallback(lead.assignedRepName ?? lead.assignedRepId, "NA")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { lead, loading, error, refetch } = useLeadDetail(id);
  const { stages } = usePipelineStages();
  const [activeTab, setActiveTab] = useState<LeadDetailTab>("timeline");
  const [isConvertDialogOpen, setIsConvertDialogOpen] = useState(false);
  const [isStageDialogOpen, setIsStageDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const currentStage = useMemo(
    () => stages.find((stage) => stage.id === lead?.stageId) ?? null,
    [lead?.stageId, stages]
  );
  const currentStageMeta = useMemo(
    () => (lead ? getLeadStageMetadata(lead.stageId, stages) : null),
    [lead, stages]
  );
  const nextLeadStage = useMemo(() => {
    const orderedLeadStages = LEAD_BOARD_STAGE_SLUGS.map((slug) =>
      stages.find((stage) => stage.slug === slug)
    ).filter((stage): stage is NonNullable<typeof stage> => stage != null);
    const currentIndex = orderedLeadStages.findIndex((stage) => stage.id === lead?.stageId);
    if (currentIndex === -1) return null;
    return orderedLeadStages[currentIndex + 1] ?? null;
  }, [lead?.stageId, stages]);
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
  const canAdvanceLeadStage = !isConverted && nextLeadStage != null;

  const isLeadEditV2 = Boolean(lead.leadQuestionnaire);
  const isHiddenReadOnly = !lead.isActive && lead.status !== "converted";
  const startQuestionnaireEdit = () => {
    setActiveTab("questionnaire");
    setIsEditing(true);
  };
  const handleTabChange = (tab: LeadDetailTab) => {
    if (tab !== "questionnaire" && isEditing) {
      const confirmed = window.confirm(
        "Leave the questionnaire editor? Unsaved lead changes will be lost."
      );
      if (!confirmed) return;
      setIsEditing(false);
    }
    setActiveTab(tab);
  };

  const secondaryAction = isHiddenReadOnly
    ? null
    : !isConverted
      ? {
          label: currentStageSlug === "sales_validation_stage" ? "Edit Sales Validation" : "Edit Lead",
          onClick: () => (isLeadEditV2 ? startQuestionnaireEdit() : navigate(`/leads/${lead.id}/edit`)),
        }
    : isLeadEditV2
      ? {
          label: "Edit Lead Questionnaire",
          onClick: () => startQuestionnaireEdit(),
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
    <div>
      <DetailPageShell
        parentLabel="Leads"
        parentHref="/leads"
        currentLabel={lead.name}
        iconSlot={<ClipboardList className="h-9 w-9" />}
        typeBadge={
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-slate-700">
            {sourceLabel(lead) ? titleCase(sourceLabel(lead)) : "Lead"}
          </span>
        }
        statusBadge={
          <>
            <LeadStageBadge stageId={lead.stageId} converted={isConverted} />
            {isConverted ? (
              <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-700">
                Converted to deal
              </span>
            ) : null}
          </>
        }
        title={lead.name}
        subtitleSlot={
          <>
            <span className="font-mono text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              {lead.convertedDealNumber ?? "Lead"}
            </span>
            {lead.companyId && leadCompanyName ? (
              <Link to={`/companies/${lead.companyId}`} className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red">
                <Building2 className="h-4 w-4" />
                {leadCompanyName}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-4 w-4" />
                Unassigned company
              </span>
            )}
            {propertyLine ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                {propertyLine}
              </span>
            ) : null}
            <span>{daysSince(lead.stageEnteredAt) == null ? "Stage age unavailable" : `${daysSince(lead.stageEnteredAt)}d in stage`}</span>
          </>
        }
        actionsSlot={
          <>
            {!isEditing && secondaryAction ? (
              secondaryAction.label.startsWith("Open") && lead.convertedDealId ? (
                <Link
                  to={
                    secondaryAction.label === "Open Opportunity Scope"
                      ? `/deals/${lead.convertedDealId}?tab=scoping`
                      : `/deals/${lead.convertedDealId}`
                  }
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  <ExternalLink className="h-4 w-4" />
                  {secondaryAction.label}
                </Link>
              ) : (
                <Button variant="outline" size="sm" onClick={secondaryAction.onClick}>
                  <Edit className="h-4 w-4" />
                  {secondaryAction.label}
                </Button>
              )
            ) : null}
            {!isEditing && canAdvanceLeadStage ? (
              <Button variant="secondary" size="sm" onClick={() => setIsStageDialogOpen(true)}>
                Move to {nextLeadStage.name}
              </Button>
            ) : null}
            {!isEditing && canConvertToOpportunity ? (
              <Button size="sm" className="bg-brand-red text-white hover:bg-brand-red/90" onClick={() => setIsConvertDialogOpen(true)}>
                Convert to Opportunity
              </Button>
            ) : null}
          </>
        }
        kpis={buildLeadKpis(lead)}
        tabs={buildLeadTabs()}
        activeTabId={activeTab}
        onTabChange={(tab) => handleTabChange(tab as LeadDetailTab)}
        rightRail={
          <LeadRightRail
            lead={lead}
            leadCompanyName={leadCompanyName}
            propertyLine={propertyLine}
            contextTitle={contextTitle}
            contextMessage={contextMessage}
            contextFootnote={contextFootnote}
            converted={isConverted}
            hiddenReadOnly={isHiddenReadOnly}
            onSaved={() => {
              void refetch();
            }}
          />
        }
      >
        {activeTab === "timeline" ? (
          <LeadTimelineTab
            leadId={lead.id}
            convertedDealId={lead.convertedDealId}
            convertedAt={convertedAt}
          />
        ) : null}
        {activeTab === "questionnaire" ? (
          isEditing && isLeadEditV2 ? (
            <LeadQuestionnaireEditor
              lead={lead}
              onCancel={() => setIsEditing(false)}
              onSaved={async () => {
                await refetch();
                setIsEditing(false);
              }}
            />
          ) : (
            <LeadQuestionnaireSummary
              lead={toLeadFormShape(lead, leadCompanyName)}
            />
          )
        ) : null}
        {activeTab === "files" ? <LeadFileTab leadId={lead.id} /> : null}
        {activeTab === "photos" ? <LeadPhotosTab leadId={lead.id} /> : null}
        {activeTab === "emails" ? <LeadEmailTab leadId={lead.id} /> : null}
        {activeTab === "recordings" ? <RecordingList entityType="lead" entityId={lead.id} /> : null}
      </DetailPageShell>

      <LeadConvertDialog
        lead={lead}
        open={isConvertDialogOpen}
        onOpenChange={setIsConvertDialogOpen}
        onSuccess={(dealId) => navigate(`/deals/${dealId}?tab=scoping`)}
      />

      {nextLeadStage ? (
        <LeadStageChangeDialog
          lead={lead}
          targetStageId={nextLeadStage.id}
          targetStageName={nextLeadStage.name}
          open={isStageDialogOpen}
          onOpenChange={setIsStageDialogOpen}
          onEditLead={() => (isLeadEditV2 ? startQuestionnaireEdit() : navigate(`/leads/${lead.id}/edit`))}
          onSuccess={() => {
            setIsStageDialogOpen(false);
            void refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function buildLeadTabs(): DetailPageShellTab[] {
  const iconClassName = "h-4 w-4";
  return [
    { id: "timeline", label: "Timeline", icon: <Clock className={iconClassName} /> },
    { id: "questionnaire", label: "Questionnaire", icon: <ClipboardList className={iconClassName} /> },
    { id: "files", label: "Files", icon: <FileText className={iconClassName} /> },
    { id: "photos", label: "Photos", icon: <Images className={iconClassName} /> },
    { id: "emails", label: "Emails", icon: <Mail className={iconClassName} /> },
    { id: "recordings", label: "Recordings", icon: <Mic className={iconClassName} /> },
  ];
}

function buildLeadKpis(lead: LeadRecord): DetailPageShellKpi[] {
  const stageAgeDays = daysSince(lead.stageEnteredAt);
  const source = sourceLabel(lead);
  const estimate = leadEstimatedValue(lead);
  return [
    {
      eyebrow: "Estimated value",
      value: formatCurrency(estimate),
      captionLabel: lead.forecastRevenue ? "Forecast" : lead.qualificationBudgetAmount ? "Qualified" : estimate ? "Estimated" : "No data",
      captionContext: lead.forecastGrossProfit ? `${formatCurrency(lead.forecastGrossProfit)} gross profit` : "lead estimate",
    },
    {
      eyebrow: "Days in stage",
      value: stageAgeDays == null ? "Unknown" : `${stageAgeDays}`,
      captionLabel: stageAgeDays == null ? "No data" : "Tracked",
      captionContext: "from stage entry",
    },
    {
      eyebrow: "Source",
      value: source ? titleCase(source) : "Unknown",
      captionLabel: lead.sourceCategory ?? "Source",
      captionContext: lead.sourceDetail ?? lead.source ?? "No detail",
    },
  ];
}

function toLeadFormShape(lead: LeadRecord, leadCompanyName: string | null) {
  return {
    id: lead.id,
    name: lead.name,
    convertedDealId: lead.convertedDealId,
    convertedDealNumber: lead.convertedDealNumber,
    companyId: lead.companyId ?? null,
    companyName: leadCompanyName,
    stageId: lead.stageId,
    assignedRepId: lead.assignedRepId,
    salesRepId: lead.salesRepId,
    assignedRepName: lead.assignedRepName,
    propertyId: lead.propertyId,
    propertyName: lead.property?.name ?? null,
    propertyAddress: lead.property?.address ?? null,
    propertyCity: lead.property?.city ?? null,
    propertyState: lead.property?.state ?? null,
    propertyZip: lead.property?.zip ?? null,
    source: lead.source,
    sourceCategory: lead.sourceCategory,
    sourceDetail: lead.sourceDetail,
    existingCustomerStatus: lead.existingCustomerStatus,
    description: lead.description,
    projectTypeId: lead.projectTypeId,
    projectType: lead.projectType,
    qualificationPayload: lead.qualificationPayload,
    projectTypeQuestionPayload: lead.projectTypeQuestionPayload,
    leadQuestionnaire: lead.leadQuestionnaire ?? null,
    stageEnteredAt: lead.stageEnteredAt,
    verificationStatus: lead.verificationStatus,
    verificationRequiredReason: lead.verificationRequiredReason,
  };
}

function LeadRightRail({
  lead,
  leadCompanyName,
  propertyLine,
  contextTitle,
  contextMessage,
  contextFootnote,
  converted,
  hiddenReadOnly,
  onSaved,
}: {
  lead: LeadRecord;
  leadCompanyName: string | null;
  propertyLine: string;
  contextTitle: string;
  contextMessage: string;
  contextFootnote: string | null;
  converted: boolean;
  hiddenReadOnly: boolean;
  onSaved: () => void;
}) {
  return (
    <div className="space-y-4">
      {hiddenReadOnly ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Hidden lead records are read-only.
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-5 p-5">
          <DetailRailSection title="Company">
            <DetailRailItem
              label="Account"
              value={
                lead.companyId && leadCompanyName ? (
                  <Link to={`/companies/${lead.companyId}`} className="text-brand-red hover:underline">
                    {leadCompanyName}
                  </Link>
                ) : (
                  "Unassigned"
                )
              }
            />
          </DetailRailSection>

          <DetailRailSection title="Primary Contact">
            <DetailRailItem
              label="Contact"
              value={
                lead.primaryContactId ? (
                  <Link to={`/contacts/${lead.primaryContactId}`} className="text-brand-red hover:underline">
                    {lead.primaryContactName ?? "Unknown contact"}
                  </Link>
                ) : (
                  "No primary contact"
                )
              }
            />
            {lead.primaryContactTitle ? <DetailRailItem label="Title" value={lead.primaryContactTitle} /> : null}
          </DetailRailSection>

          <DetailRailSection title="Owner">
            <DetailRailItem
              label="Assigned rep"
              value={
                <span className="inline-flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-900 text-[10px] font-black uppercase text-white">
                    {ownerInitials(lead)}
                  </span>
                  {displayNameOrFallback(lead.assignedRepName ?? lead.assignedRepId, "Unknown user")}
                </span>
              }
            />
          </DetailRailSection>

          <DetailRailSection title="Property">
            <DetailRailItem
              label="Property"
              value={
                lead.propertyId ? (
                  <Link to={`/properties/${lead.propertyId}`} className="text-brand-red hover:underline">
                    {lead.property?.name ?? propertyLine ?? "Open property"}
                  </Link>
                ) : (
                  "No property linked"
                )
              }
            />
            {propertyLine ? <DetailRailItem label="Address" value={propertyLine} /> : null}
          </DetailRailSection>

          <DetailRailSection title="Project type">
            <DetailRailItem label="Type" value={lead.projectType?.name ?? "Not set"} />
          </DetailRailSection>

          <DetailRailSection title="Source">
            <DetailRailItem label="Source" value={formatNullable(lead.source)} />
            <DetailRailItem label="Category" value={formatNullable(lead.sourceCategory)} />
            <DetailRailItem label="Detail" value={formatNullable(lead.sourceDetail)} />
          </DetailRailSection>

          <DetailRailSection title="Verification">
            <DetailRailItem label="Status" value={titleCase(lead.verificationStatus)} />
            {lead.verificationRequiredReason ? (
              <DetailRailItem label="Reason" value={titleCase(lead.verificationRequiredReason)} />
            ) : null}
          </DetailRailSection>

          <DetailRailSection title="Status">
            <DetailRailItem label="Lead status" value={titleCase(lead.status)} />
            <DetailRailItem label="Primary contact" value={lead.primaryContactId ? lead.primaryContactName ?? "Unknown contact" : "No primary contact yet"} />
            <DetailRailItem label="Activity" value={lead.lastActivityAt ? "Activity recorded" : "No activity yet"} />
          </DetailRailSection>

          {converted ? (
            <DetailRailSection title="Conversion">
              <DetailRailItem
                label="Converted to deal"
                value={
                  lead.convertedDealId ? (
                    <Link to={`/deals/${lead.convertedDealId}`} className="text-brand-red hover:underline">
                      {lead.convertedDealNumber ?? "Open deal"}
                    </Link>
                  ) : (
                    formatNullable(lead.convertedDealNumber)
                  )
                }
              />
            </DetailRailSection>
          ) : null}

          <DetailRailSection title="System references">
            <DetailRailItem label="Lead" value="Tracked internally" />
            <DetailRailItem label="Company" value={lead.companyId ? "Linked internally" : "Not set"} />
            <DetailRailItem label="Property" value={lead.propertyId ? "Linked internally" : "Not set"} />
            <DetailRailItem label="Converted deal" value={lead.convertedDealId ? "Linked internally" : "Not set"} />
          </DetailRailSection>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">{contextTitle}</p>
          </div>
          <p className="text-sm text-muted-foreground">{contextMessage}</p>
          {contextFootnote ? <p className="text-xs text-muted-foreground">{contextFootnote}</p> : null}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <User className="h-4 w-4" />
            <span>{lead.primaryContactId ? lead.primaryContactName ?? "Unknown contact" : "No primary contact yet"}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Phone className="h-4 w-4" />
            <span>{lead.lastActivityAt ? "Activity recorded" : "No activity yet"}</span>
          </div>
        </CardContent>
      </Card>

      <LeadForm
        lead={toLeadFormShape(lead, leadCompanyName)}
        showPrimaryAction={false}
        converted={converted}
        onSaved={onSaved}
      />
    </div>
  );
}
