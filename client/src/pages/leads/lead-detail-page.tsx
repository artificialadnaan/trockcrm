import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Building2,
  ClipboardList,
  Activity,
  Clock,
  Clock3,
  Edit,
  ExternalLink,
  FileText,
  Images,
  Mail,
  MapPin,
  Mic,
  MoreHorizontal,
  Phone,
  Trash2,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  DetailPageShell,
  DetailRailItem,
  DetailRailSection,
  type DetailPageShellKpi,
  type DetailPageShellTab,
} from "@/components/layout/detail-page-shell";
import { LeadForm, LeadQuestionnaireSummary } from "@/components/leads/lead-form";
import { OwnerLabel } from "@/components/shared/owner-label";
import { LeadConvertDialog } from "@/components/leads/lead-convert-dialog";
import { LeadStageChangeDialog } from "@/components/leads/lead-stage-change-dialog";
import { LeadStageBadge } from "@/components/leads/lead-stage-badge";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { LeadQuestionnaireEditor } from "@/components/leads/lead-questionnaire-editor";
import { RecordingList } from "@/components/call-recordings/recording-list";
import { EntityActivityTab } from "@/components/activities/entity-activity-tab";
import { LeadEmailTab } from "@/components/email/lead-email-tab";
import { LeadFileTab } from "@/components/files/lead-file-tab";
import { LeadPhotosTab } from "./lead-photos-tab";
import {
  deleteLead as apiDeleteLead,
  formatLeadPropertyLine,
  getLeadStageMetadata,
  updateLead as apiUpdateLead,
  useLeadDetail,
} from "@/hooks/use-leads";
import type { LeadRecord } from "@/hooks/use-leads";
import { useSalesReps } from "@/hooks/use-sales-reps";
import { useAuth } from "@/lib/auth";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { LEAD_BOARD_STAGE_SLUGS, isBidBoardMirroredStageSlug } from "@/lib/pipeline-ownership";
import { cn } from "@/lib/utils";
import { displayNameOrFallback } from "@/lib/display-identifiers";
import { api } from "@/lib/api";
import { canArchiveLead } from "./lead-archive-eligibility";

type LeadDetailTab = "timeline" | "questionnaire" | "files" | "photos" | "emails" | "activity" | "recordings";

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
  const location = useLocation();
  const { user } = useAuth();
  const { lead, loading, error, refetch, patchLead } = useLeadDetail(id);
  const { stages } = usePipelineStages();
  const [activeTab, setActiveTab] = useState<LeadDetailTab>("timeline");
  const [isConvertDialogOpen, setIsConvertDialogOpen] = useState(false);
  const [isStageDialogOpen, setIsStageDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [watchPending, setWatchPending] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const leadActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const archiveReasonRef = useRef<HTMLTextAreaElement | null>(null);

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
  const viewerOwnsLead = lead?.assignedRepId === user?.id;

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
  const showArchiveAction = canArchiveLead(lead, user);
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
  const handleWatchToggle = async () => {
    if (!lead?.id || watchPending) return;
    setWatchPending(true);
    try {
      if (lead.isWatching) {
        await api(`/leads/${lead.id}/watch`, { method: "DELETE" });
        toast.success("Lead removed from Mine");
      } else {
        await api(`/leads/${lead.id}/watch`, { method: "POST" });
        toast.success("Lead added to Mine");
      }
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update watch state");
    } finally {
      setWatchPending(false);
    }
  };
  const handleArchiveSubmit = async () => {
    if (archiving || archiveReason.trim().length === 0) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await apiDeleteLead(lead.id, archiveReason.trim());
      toast.success("Lead archived");
      navigate({ pathname: "/leads", search: location.search });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to archive lead";
      setArchiveError(message);
      toast.error(message);
    } finally {
      setArchiving(false);
    }
  };
  const closeArchiveDialog = () => {
    if (archiving) return;
    setArchiveOpen(false);
    setArchiveReason("");
    setArchiveError(null);
    queueMicrotask(() => leadActionsTriggerRef.current?.focus());
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
              <span className="inline-flex items-center gap-2">
                <Link to={`/companies/${lead.companyId}`} className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red">
                  <Building2 className="h-4 w-4" />
                  {leadCompanyName}
                </Link>
                <OwnerLabel ownerId={lead.companyOwnerUserId ?? null} ownerName={lead.companyOwnerUserName ?? null} />
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-4 w-4" />
                Unassigned company
              </span>
            )}
            {lead.assignedRepName ? <span>Assigned to {lead.assignedRepName}</span> : null}
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
            <Button variant="outline" size="sm" onClick={handleWatchToggle} disabled={watchPending}>
              {lead.isWatching ? "Watching" : "Watch this lead"}
            </Button>
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={secondaryAction.onClick}
                  disabled={!viewerOwnsLead}
                  title={!viewerOwnsLead ? "Only the assigned rep can edit" : undefined}
                >
                  <Edit className="h-4 w-4" />
                  {secondaryAction.label}
                </Button>
              )
            ) : null}
            {!isEditing && canAdvanceLeadStage ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsStageDialogOpen(true)}
                disabled={!viewerOwnsLead}
                title={!viewerOwnsLead ? "Only the assigned rep can edit" : undefined}
              >
                Move to {nextLeadStage.name}
              </Button>
            ) : null}
            {!isEditing && canConvertToOpportunity ? (
              <Button
                size="sm"
                className="bg-brand-red text-white hover:bg-brand-red/90"
                onClick={() => setIsConvertDialogOpen(true)}
                disabled={!viewerOwnsLead}
                title={!viewerOwnsLead ? "Only the assigned rep can edit" : undefined}
              >
                Convert to Opportunity
              </Button>
            ) : null}
            {!isEditing && showArchiveAction ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      ref={leadActionsTriggerRef}
                      variant="outline"
                      size="icon"
                      aria-label="More lead actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      setArchiveError(null);
                      setArchiveOpen(true);
                    }}
                    variant="destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Archive Lead
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
        kpis={buildLeadKpis(lead)}
        tabs={buildLeadTabs().map((tab) => (
          tab.id === "emails" ? { ...tab, count: lead.emailCount ?? 0 } : tab
        ))}
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
            editing={isEditing}
            onLeadUpdated={patchLead}
          />
        }
      >
        {!viewerOwnsLead ? (
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-600">
            Assigned to {lead.assignedRepName ?? lead.assignedRepId ?? "another rep"}. You can collaborate with notes, activity, files, photos, and emails, but only the assigned rep can edit.
          </div>
        ) : null}
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
        {activeTab === "activity" ? <EntityActivityTab entityType="lead" entityId={lead.id} emptyLabel="lead" /> : null}
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

      <Dialog
        open={archiveOpen}
        onOpenChange={(open) => {
          if (open) setArchiveOpen(true);
          else closeArchiveDialog();
        }}
      >
        <DialogContent
          className="sm:max-w-[480px]"
          initialFocus={archiveReasonRef}
          showCloseButton={!archiving}
        >
          <DialogHeader>
            <DialogTitle>Archive “{lead.name}”?</DialogTitle>
            <DialogDescription>
              It will be removed from active lead views and become read-only. Linked company, property,
              contact, files, photos, timeline, and activity are retained. The reason is saved at the top of
              the lead description.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="lead-archive-reason">Reason</Label>
            <Textarea
              ref={archiveReasonRef}
              id="lead-archive-reason"
              placeholder="Why are you archiving this lead?"
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
              rows={3}
              required
            />
            {archiveError ? (
              <p className="text-sm font-medium text-red-600" role="alert">
                {archiveError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeArchiveDialog} disabled={archiving}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleArchiveSubmit}
              disabled={archiving || archiveReason.trim().length === 0}
            >
              {archiving ? "Archiving…" : "Archive lead"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    { id: "emails", label: "Emails", icon: <Mail className={iconClassName} />, count: 0 },
    { id: "activity", label: "Activity", icon: <Activity className={iconClassName} /> },
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
    companyOwnerUserId: lead.companyOwnerUserId ?? null,
    companyOwnerUserName: lead.companyOwnerUserName ?? null,
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
    primaryContactId: lead.primaryContactId,
    primaryContactName: lead.primaryContactName,
    primaryContactOwnerUserId: lead.primaryContactOwnerUserId ?? null,
    primaryContactOwnerUserName: lead.primaryContactOwnerUserName ?? null,
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
  editing,
  onLeadUpdated,
}: {
  lead: LeadRecord;
  leadCompanyName: string | null;
  propertyLine: string;
  contextTitle: string;
  contextMessage: string;
  contextFootnote: string | null;
  converted: boolean;
  hiddenReadOnly: boolean;
  editing: boolean;
  onLeadUpdated: (updater: (currentLead: LeadRecord) => LeadRecord) => void;
}) {
  const { user } = useAuth();
  const canReassignLead =
    !hiddenReadOnly &&
    !converted &&
    !editing &&
    Boolean(user) &&
    (user?.role === "admin" ||
      user?.role === "director" ||
      user?.id === lead.assignedRepId);
  const {
    salesReps,
    loading: salesRepsLoading,
    error: salesRepsError,
    refetch: refetchSalesReps,
  } = useSalesReps(undefined, {
    purpose: "lead-reassignment",
    enabled: canReassignLead,
  });
  const [pendingOwnerId, setPendingOwnerId] = useState(lead.assignedRepId);
  const [reassigning, setReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const ownerOptions = salesReps.some((rep) => rep.id === lead.assignedRepId)
    ? salesReps
    : [
        {
          id: lead.assignedRepId,
          displayName: displayNameOrFallback(lead.assignedRepName ?? lead.assignedRepId, "Current assigned rep"),
        },
        ...salesReps,
      ];

  useEffect(() => {
    setPendingOwnerId(lead.assignedRepId);
    setReassignError(null);
  }, [lead.id, lead.assignedRepId, editing]);

  async function handleReassign() {
    const nextRepId = pendingOwnerId;
    if (!nextRepId || nextRepId === lead.assignedRepId || reassigning) return;
    setReassigning(true);
    setReassignError(null);
    try {
      const result = await apiUpdateLead(lead.id, { assignedRepId: nextRepId });
      const selectedOwner = ownerOptions.find((owner) => owner.id === nextRepId);
      // PATCH returns the raw lead row, while the detail hook holds decorated fields (project type,
      // property, owner labels). Update only the ownership slice so those richer values stay intact.
      onLeadUpdated((currentLead) => ({
        ...currentLead,
        assignedRepId: result.lead.assignedRepId ?? nextRepId,
        salesRepId: result.lead.salesRepId ?? nextRepId,
        assignedRepName: selectedOwner?.displayName ?? currentLead.assignedRepName,
      }));
      toast.success("Lead owner updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reassign lead";
      setReassignError(message);
      toast.error(message);
    } finally {
      setReassigning(false);
    }
  }

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
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link to={`/companies/${lead.companyId}`} className="text-brand-red hover:underline">
                      {leadCompanyName}
                    </Link>
                    <OwnerLabel ownerId={lead.companyOwnerUserId ?? null} ownerName={lead.companyOwnerUserName ?? null} />
                  </span>
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
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link to={`/contacts/${lead.primaryContactId}`} className="text-brand-red hover:underline">
                      {lead.primaryContactName ?? "Unknown contact"}
                    </Link>
                    <OwnerLabel
                      ownerId={lead.primaryContactOwnerUserId ?? null}
                      ownerName={lead.primaryContactOwnerUserName ?? null}
                    />
                  </span>
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
                <div className="space-y-2">
                  <span className="inline-flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-900 text-[10px] font-black uppercase text-white">
                      {ownerInitials(lead)}
                    </span>
                    {displayNameOrFallback(lead.assignedRepName ?? lead.assignedRepId, "Unknown user")}
                  </span>
                  {canReassignLead ? (
                    <div className="space-y-1">
                      <select
                        aria-label="Reassign lead owner"
                        aria-busy={salesRepsLoading || reassigning || undefined}
                        className="h-8 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-900"
                        disabled={salesRepsLoading || reassigning || Boolean(salesRepsError) || ownerOptions.length <= 1}
                        value={pendingOwnerId}
                        onChange={(event) => {
                          setPendingOwnerId(event.currentTarget.value);
                          setReassignError(null);
                        }}
                      >
                        {ownerOptions.map((rep) => (
                          <option key={rep.id} value={rep.id}>
                            {rep.displayName}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={
                          salesRepsLoading ||
                          reassigning ||
                          Boolean(salesRepsError) ||
                          ownerOptions.length <= 1 ||
                          pendingOwnerId === lead.assignedRepId
                        }
                        onClick={() => void handleReassign()}
                      >
                        {reassigning ? "Saving owner…" : "Save owner"}
                      </Button>
                      {salesRepsLoading ? (
                        <p className="text-xs font-medium text-slate-500" role="status">
                          Loading eligible owners…
                        </p>
                      ) : null}
                      {reassigning ? (
                        <p className="text-xs font-medium text-slate-500" role="status">
                          Updating owner…
                        </p>
                      ) : null}
                      {reassignError ? (
                        <p className="text-xs font-medium text-red-600" role="alert">
                          {reassignError}
                        </p>
                      ) : null}
                      {salesRepsError ? (
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-red-600" role="alert">
                            {salesRepsError}
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => void refetchSalesReps()}
                          >
                            Retry owner list
                          </Button>
                        </div>
                      ) : null}
                      {!salesRepsLoading && !salesRepsError && ownerOptions.length <= 1 ? (
                        <p className="text-xs font-medium text-slate-500">
                          No other eligible owners in this office.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
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
            <DetailRailItem
              label="Primary contact"
              value={
                lead.primaryContactId ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span>{lead.primaryContactName ?? "Unknown contact"}</span>
                    <OwnerLabel
                      ownerId={lead.primaryContactOwnerUserId ?? null}
                      ownerName={lead.primaryContactOwnerUserName ?? null}
                    />
                  </span>
                ) : (
                  "No primary contact yet"
                )
              }
            />
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
            {lead.primaryContactId ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{lead.primaryContactName ?? "Unknown contact"}</span>
                <OwnerLabel
                  ownerId={lead.primaryContactOwnerUserId ?? null}
                  ownerName={lead.primaryContactOwnerUserName ?? null}
                />
              </span>
            ) : (
              <span>No primary contact yet</span>
            )}
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
      />
    </div>
  );
}
