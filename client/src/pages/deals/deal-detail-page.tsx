import { useState, useEffect } from "react";
import { Link, useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import {
  Activity,
  Briefcase,
  Building2,
  CalendarDays,
  DollarSign,
  Edit,
  FileText,
  History,
  Images,
  ClipboardCheck,
  ListChecks,
  Mail,
  MapPin,
  ReceiptText,
  Trash2,
  Info,
  MoreHorizontal,
  Lock,
  ExternalLink,
  Users,
  Send,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DetailPageShell,
  DetailRailItem,
  DetailRailSection,
  type DetailPageShellKpi,
  type DetailPageShellTab,
} from "@/components/layout/detail-page-shell";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { AtRiskBadge } from "@/components/deals/at-risk-badge";
import { ChangeOrderBadge } from "@/components/deals/change-order-badge";
import { ChangeOrderParentLink } from "@/components/deals/change-order-parent-link";
import { OwnerLabel } from "@/components/shared/owner-label";
import { DealEmailTab } from "@/components/email/deal-email-tab";
import { EntityActivityTab } from "@/components/activities/entity-activity-tab";
import { DealOverviewTab } from "@/components/deals/deal-overview-tab";
import { DealHistoryTab } from "@/components/deals/deal-history-tab";
import { DealTimelineTab } from "@/components/deals/deal-timeline-tab";
import { PipelineProgress } from "@/components/deals/pipeline-progress";
import { DealScopingWorkspace } from "@/components/deals/deal-scoping-workspace";
import { DealFileTab } from "@/components/files/deal-file-tab";
import { DealPhotosTab } from "./deal-photos-tab";
import { DealScorecardsTab } from "./deal-scorecards-tab";
import { DealTeamTab } from "./deal-team-tab";
import { DealEstimatesTab } from "./deal-estimates-tab";
import { DealPunchListTab } from "./deal-punch-list-tab";
import { DealCloseoutTab } from "./deal-closeout-tab";
import { DealBillingTab } from "./deal-billing-tab";
import { DealTimersBanner } from "./deal-timers-banner";
import { BidDueDateBanner } from "./bid-due-date-banner";
import { RfpVotePanel } from "./rfp-vote-panel";
import { DealProposalCard } from "./deal-proposal-card";
import { DealContractSignedCard } from "./deal-contract-signed-card";
import { DealEstimatingSubstage } from "./deal-estimating-substage";
import { LeadForm } from "@/components/leads/lead-form";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { ReturnToOpportunityDialog } from "@/components/deals/return-to-opportunity-dialog";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import {
  useDealDetail,
  deleteDeal as apiDeleteDeal,
  updateDeal as apiUpdateDeal,
  updateDealEstimator as apiUpdateDealEstimator,
  updateDealSalesSource as apiUpdateDealSalesSource,
  type DealDetail,
} from "@/hooks/use-deals";
import { canArchiveDeal } from "./deal-archive-eligibility";
import { useLeadDetail } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { useSalesReps, type SalesRepOption } from "@/hooks/use-sales-reps";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { buildProcoreBidBoardProjectUrl } from "@/lib/procore";
import { isDealScopeReadOnlyAfterRfp } from "@/lib/deal-scope-lock";
import { isRfpDetailPollActive } from "@/lib/rfp-detail-poll";
import { formatCurrency, bestEstimateCaptionLabel, formatDealDisplayNumber, resolveBestEstimate, resolveDealValueKind, LOST_BID_VALUE_LABEL } from "@/lib/deal-utils";
import {
  getCanonicalDealStageSlugs,
  getDealStageLabelBySlug,
  isEstimatingBoundaryStageSlug,
  isSelectableDealStageSlug,
  normalizeDealStageSlug,
} from "@/lib/pipeline-ownership";
import {
  getDealAtRiskResult,
  getCanonicalEstimatingBoundaryStageSlug,
  getOwnerInitialColor,
  isReturnToOpportunityNoOp,
  pendingRfpSubStateForStatus,
  resolveEffectiveStageEnteredAt,
  toCanonicalDealStageSlug,
  type AtRiskResult,
  type UserRole,
} from "@trock-crm/shared/types";

function bidBoardSyncTimeAgo(date: string | null | undefined) {
  if (!date) return "unknown";
  const syncedAt = new Date(date).getTime();
  if (!Number.isFinite(syncedAt)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - syncedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function titleCase(value: string) {
  const minorWords = new Set(["and", "or", "in", "of", "to", "from", "by"]);
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && minorWords.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function bidBoardStageLabel(deal: DealDetail) {
  return titleCase(deal.bidBoardStageSlug || deal.bidBoardStatus || "Unknown stage");
}

function formatBidBoardEstimate(value: string | number | null | undefined) {
  if (value == null || value === "") return "Not available";
  const amount = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount)) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function buildBidBoardProjectUrl(deal: Pick<DealDetail, "procoreCompanyId" | "procoreBidId">) {
  return buildProcoreBidBoardProjectUrl(deal.procoreCompanyId, deal.procoreBidId);
}

type Tab = "overview" | "lead" | "scoping" | "files" | "photos" | "scorecards" | "email" | "activity" | "timeline" | "history" | "team" | "billing" | "estimates" | "punch_list" | "closeout";

function formatNullable(value: string | number | null | undefined) {
  if (value == null || value === "") return "Not set";
  return String(value);
}

// Shared builder for the owner / estimator / sales-source rep pickers: drop the excluded reps, then if the
// current value isn't in the remaining list (an inactive rep, or one excluded by an invariant) pin it to the
// top with a readable label — prefer the server-provided name, else the active-list name, else a fallback.
// One place so the three pickers can't drift on exclusion or fallback behavior.
function buildRepOptions(
  reps: SalesRepOption[],
  opts: {
    excludeIds: (string | null | undefined)[];
    currentId: string | null | undefined;
    currentServerName?: string | null;
    fallbackLabel: string;
  }
): SalesRepOption[] {
  const excluded = new Set(opts.excludeIds.filter((id): id is string => Boolean(id)));
  const options = reps.filter((rep) => !excluded.has(rep.id));
  if (opts.currentId && !options.some((rep) => rep.id === opts.currentId)) {
    options.unshift({
      id: opts.currentId,
      displayName:
        opts.currentServerName ??
        reps.find((rep) => rep.id === opts.currentId)?.displayName ??
        opts.fallbackLabel,
    });
  }
  return options;
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Unscheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unscheduled";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// No-UTC-drift formatter for date-ONLY values ("YYYY-MM-DD"): new Date("2026-09-01") parses as midnight
// UTC and renders the PRIOR calendar day in zones behind UTC, so split the parts into a LOCAL date.
function formatDateOnly(value: string | null | undefined) {
  if (!value) return "Unscheduled";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return formatDate(value);
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDealAddress(deal: DealDetail) {
  return [deal.propertyAddress, deal.propertyCity, deal.propertyState, deal.propertyZip]
    .filter(Boolean)
    .join(", ");
}

function formatDealType(deal: DealDetail) {
  return deal.projectType || titleCase(deal.workflowRoute === "service" ? "service" : deal.source || "deal");
}

function buildProcoreProjectUrl(procoreProjectId: number | null | undefined) {
  if (!procoreProjectId) return null;
  return `https://app.procore.com/projects/${procoreProjectId}`;
}

function normalizeUserRole(role: string | null | undefined): UserRole | null {
  if (role === "rep" || role === "director" || role === "admin") return role;
  return null;
}

function resolveDetailSlaStageSlug(
  deal: DealDetail,
  currentStage: { slug?: string | null; isTerminal?: boolean | null } | undefined
) {
  const actualStageSlug = deal.stageSlug ?? currentStage?.slug ?? deal.stageId ?? null;
  if (currentStage?.isTerminal) return actualStageSlug;
  return deal.bidBoardStageSlug ?? actualStageSlug;
}

function getDealDetailSlaResult(
  deal: DealDetail,
  currentStage: { slug?: string | null; isTerminal?: boolean | null } | undefined,
  userRole: string | null | undefined
): AtRiskResult | null {
  if (deal.atRisk) return deal.atRisk;

  const stageEnteredAt = resolveEffectiveStageEnteredAt(deal);
  if (!stageEnteredAt) return null;

  return getDealAtRiskResult(
    {
      stageSlug: resolveDetailSlaStageSlug(deal, currentStage),
      workflowRoute: deal.workflowRoute ?? "normal",
      stageEnteredAt,
      onHold: deal.onHold,
      onHoldStartedAt: deal.onHoldStartedAt,
      onHoldAccumulatedSeconds: deal.onHoldAccumulatedSeconds,
      onHoldAccumulatedSecondsAtStageEntry: deal.onHoldAccumulatedSecondsAtStageEntry,
      // A today-or-future close target postpones the at-risk verdict (mirrors the server path).
      expectedCloseDate: deal.expectedCloseDate,
    },
    normalizeUserRole(userRole),
    new Date()
  );
}

function getSlaCaptionLabel(atRisk: AtRiskResult | null) {
  if (!atRisk) return "No data";
  if (atRisk.reason === "on_hold") return "Paused";
  if (atRisk.reason === "close_target_pending") return "Postponed";
  if (atRisk.status === "not_applicable") return "Not applicable";
  return atRisk.isAtRisk ? "Over SLA" : "On track";
}

function getSlaStatusValue(atRisk: AtRiskResult | null) {
  if (!atRisk) return "Unknown";
  if (atRisk.reason === "on_hold") return "On Hold";
  if (atRisk.reason === "close_target_pending") return "Postponed";
  if (atRisk.status === "not_applicable") return "Not applicable";
  return atRisk.isAtRisk ? "Overdue" : "Current";
}

function getSlaCaptionContext(atRisk: AtRiskResult | null, expectedCloseDate?: string | null) {
  if (!atRisk) return "SLA unavailable";
  if (atRisk.reason === "close_target_pending" && expectedCloseDate) {
    return `Postponed until ${formatDateOnly(expectedCloseDate)}`;
  }
  return atRisk.thresholdDays == null ? "No SLA threshold" : `SLA ${atRisk.thresholdDays} days`;
}

function appendOfficeIdSearch(path: string, officeId?: string | null) {
  if (!officeId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}officeId=${encodeURIComponent(officeId)}`;
}

function getTabIcon(tab: Tab) {
  const iconClassName = "h-4 w-4";
  switch (tab) {
    case "overview":
      return <ReceiptText className={iconClassName} />;
    case "lead":
      return <Briefcase className={iconClassName} />;
    case "scoping":
      return <ListChecks className={iconClassName} />;
    case "files":
      return <FileText className={iconClassName} />;
    case "photos":
      return <Images className={iconClassName} />;
    case "scorecards":
      return <ClipboardCheck className={iconClassName} />;
    case "email":
      return <Mail className={iconClassName} />;
    case "activity":
      return <Activity className={iconClassName} />;
    case "timeline":
      return <CalendarDays className={iconClassName} />;
    case "history":
      return <History className={iconClassName} />;
    case "team":
      return <Users className={iconClassName} />;
    case "billing":
      return <DollarSign className={iconClassName} />;
    case "estimates":
      return <ReceiptText className={iconClassName} />;
    case "punch_list":
      return <ListChecks className={iconClassName} />;
    case "closeout":
      return <FileText className={iconClassName} />;
    default:
      return <FileText className={iconClassName} />;
  }
}

export function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const detailOfficeId = searchParams.get("officeId");
  const { deal, loading, error, refetch, refetchSilent } = useDealDetail(id, { officeId: detailOfficeId });

  // Poll the detail every 5s while an RFP is ACTIVELY in flight so the panel flips to its resolved state without a
  // manual refresh — but only while the request is RECENT (isRfpDetailPollActive). Gating on rfpApprovalStatus alone
  // made deals stuck 'pending' from an old/failed request (and, with RFP voting off, deals that can never resolve)
  // refresh the page every 5s FOREVER; the recency window stops that while still catching a genuine trigger →
  // pending_outbox → approved / send_failed (Retry) resolution. Re-checked in the tick so a request that never
  // resolves also self-terminates once it ages out of the window. Uses refetchSilent so the tick updates the vote
  // state IN PLACE — no loading-spinner flash / page blank every 5s.
  useEffect(() => {
    if (!isRfpDetailPollActive(deal?.rfpApprovalStatus, deal?.rfpApprovalRequestedAt, Date.now())) return;
    const interval = setInterval(() => {
      if (!isRfpDetailPollActive(deal?.rfpApprovalStatus, deal?.rfpApprovalRequestedAt, Date.now())) {
        clearInterval(interval);
        return;
      }
      refetchSilent();
    }, 5000);
    return () => clearInterval(interval);
  }, [deal?.rfpApprovalStatus, deal?.rfpApprovalRequestedAt, refetchSilent]);

  const { stages } = usePipelineStages();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [targetStageId, setTargetStageId] = useState<string | null>(null);
  const [teamCount, setTeamCount] = useState<number | null>(null);
  const [photoCount, setPhotoCount] = useState<number | null>(null);
  const [rfpRetrying, setRfpRetrying] = useState(false);
  const [rfpTriggering, setRfpTriggering] = useState(false);
  const [rfpTriggerError, setRfpTriggerError] = useState<string | null>(null);
  const [rfpCancelling, setRfpCancelling] = useState(false);
  const [rfpReadinessStatus, setRfpReadinessStatus] = useState<"draft" | "ready" | "activated" | null>(null);
  const [rfpReadinessLoading, setRfpReadinessLoading] = useState(false);
  const [rfpReadinessRefreshKey, setRfpReadinessRefreshKey] = useState(0);
  const [watchPending, setWatchPending] = useState(false);
  const [holdTogglePending, setHoldTogglePending] = useState(false);
  const [returnToOpportunityOpen, setReturnToOpportunityOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiving, setArchiving] = useState(false);
  const currentStage = stages.find((s) => s.id === deal?.stageId);
  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";
  const viewerOwnsDeal = deal?.assignedRepId === user?.id;
  const bidBoardOwnership = deal?.bidBoardOwnership;
  const isBidBoardOwned = Boolean(deal?.isBidBoardOwned || bidBoardOwnership?.isOwned);
  const workflowRoute = deal?.workflowRoute ?? "normal";
  const dealStages = stages.filter(
    (stage) =>
      stage.isActivePipeline !== false &&
      isSelectableDealStageSlug(stage.slug) &&
      toCanonicalDealStageSlug(stage.slug, workflowRoute) != null
  );
  const canonicalStageSlugs = getCanonicalDealStageSlugs(workflowRoute) as string[];
  const canonicalOrderedStages = canonicalStageSlugs
    .map((slug) => {
      const exactFamilyMatch = dealStages.find(
        (stage) =>
          stage.slug === slug &&
          (workflowRoute === "service"
            ? stage.workflowFamily === "service_deal"
            : stage.workflowFamily === "standard_deal")
      );
      const normalizedMatch =
        exactFamilyMatch ??
        dealStages.find((stage) => normalizeDealStageSlug(stage.slug, workflowRoute) === slug);

      if (!normalizedMatch) {
        return null;
      }

      return {
        ...normalizedMatch,
        slug,
        name: getDealStageLabelBySlug(slug as Parameters<typeof getDealStageLabelBySlug>[0]),
      };
    })
    .filter((stage): stage is NonNullable<typeof stage> => stage != null);

  const canonicalCurrentStageSlug =
    currentStage == null ? null : toCanonicalDealStageSlug(currentStage.slug, workflowRoute);
  const handoffStageSlug =
    bidBoardOwnership?.handoffStageSlug ?? getCanonicalEstimatingBoundaryStageSlug(workflowRoute);
  const handoffStage =
    canonicalOrderedStages.find((s) => s.slug === handoffStageSlug) ??
    canonicalOrderedStages.find((s) => isEstimatingBoundaryStageSlug(s.slug, workflowRoute));

  const handleStageChange = (stageId: string) => {
    setTargetStageId(stageId);
    setStageChangeOpen(true);
  };

  const handleStageChangeSuccess = () => {
    setStageChangeOpen(false);
    setTargetStageId(null);
    refetch();
  };

  const handleArchiveSubmit = async () => {
    if (!deal || archiveReason.trim().length === 0) return;
    setArchiving(true);
    try {
      await apiDeleteDeal(deal.id, archiveReason.trim());
      navigate("/deals");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to archive deal");
    } finally {
      setArchiving(false);
    }
  };

  const handleRfpRetry = async () => {
    if (!deal) return;
    setRfpRetrying(true);
    try {
      await api(`/deals/${deal.id}/rfp-retry`, { method: "POST" });
      await refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to retry RFP delivery");
    } finally {
      setRfpRetrying(false);
    }
  };

  const handleHoldToggle = async () => {
    if (!deal || holdTogglePending) return;
    setHoldTogglePending(true);
    try {
      await apiUpdateDeal(deal.id, { onHold: !deal.onHold });
      toast.success(deal.onHold ? "Deal resumed from hold" : "Deal placed on hold");
      try {
        await refetch();
      } catch {
        toast.info("On Hold status updated. Refresh the page to see the latest detail state.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update On Hold status");
    } finally {
      setHoldTogglePending(false);
    }
  };

  const currentStageSlug = currentStage?.slug ?? "";
  const isOpportunityStage = canonicalCurrentStageSlug === "opportunity";
  // The SERVER's linkage answer, not a client re-derivation. The first version of this guard rebuilt
  // the predicate here and promptly drifted — it omitted synchub_bid_board_id and read_only_synced_at,
  // so a SyncHub-created deal that had been walked backward could reach a stable-id-only state where
  // the next webhook could still reclaim it while the UI hid the only action that would stop that.
  // buildBidBoardOwnershipState now publishes isBidBoardLinked from the same test the service uses.
  const isDealStillBidBoardLinked = Boolean(deal?.bidBoardOwnership?.isBidBoardLinked);
  const opportunityStage = dealStages.find(
    (stage) =>
      stage.slug === "opportunity" &&
      stage.workflowFamily === currentStage?.workflowFamily
  );
  const isPastOpportunityStage = Boolean(
    currentStage &&
    opportunityStage &&
    currentStage.workflowFamily === opportunityStage.workflowFamily &&
    currentStage.displayOrder > opportunityStage.displayOrder
  );
  // Shared with the deal edit form (deal-form.tsx) so both surfaces grey out the same fields.
  // isBidBoardOwned here also folds in inferred ownership, so pass it explicitly.
  const isScopeReadOnlyAfterRfp = deal
    ? isDealScopeReadOnlyAfterRfp({ ...deal, isBidBoardOwned }, { isPastOpportunityStage })
    : false;
  const scopeSubmittedAt =
    deal?.rfpApprovalRequestedAt ??
    deal?.bidBoardLinkedAt ??
    deal?.readOnlySyncedAt ??
    null;
  const canTriggerRfp =
    user?.role === "admin" ||
    user?.role === "director" ||
    (user?.role === "rep" && deal?.assignedRepId === user.id);
  const canCancelRfp =
    user?.role === "admin" ||
    user?.role === "director" ||
    (user?.role === "rep" && deal?.assignedRepId === user.id);
  const showTriggerRfpButton = Boolean(
      deal &&
      canTriggerRfp &&
      deal.isRfpTriggerEnabled === true &&
      isOpportunityStage &&
      !isBidBoardOwned &&
      !deal.rfpApprovalStatus &&
      !deal.rfpApprovalRequestedAt
  );
  const isRfpScopeReady = rfpReadinessStatus === "ready" || rfpReadinessStatus === "activated";
  const triggerRfpDisabled = rfpReadinessLoading || !isRfpScopeReady || rfpTriggering;
  const showPunchList =
    canonicalCurrentStageSlug === "won" ||
    currentStageSlug === "sent_to_production" ||
    currentStageSlug === "service_sent_to_production";
  const showCloseout = showPunchList || currentStageSlug === "close_out";

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "lead", label: "Lead" },
    { key: "scoping", label: isOpportunityStage ? "Opportunity Scope" : "Scoping" },
    { key: "files", label: "Files" },
    { key: "photos", label: photoCount != null ? `Photos (${photoCount})` : "Photos" },
    { key: "billing", label: "Billing" },
    { key: "scorecards", label: "Scorecards" },
    { key: "email", label: "Emails" },
    { key: "activity", label: "Activity" },
    { key: "timeline", label: "Timeline" },
    { key: "history", label: "History" },
    { key: "team", label: teamCount != null ? `Team (${teamCount})` : "Team" },
    { key: "estimates", label: "Estimates" },
    ...(showPunchList ? [{ key: "punch_list" as Tab, label: "Punch List" }] : []),
    ...(showCloseout ? [{ key: "closeout" as Tab, label: "Close-Out" }] : []),
  ];
  const availableTabs = tabs.map((tab) => tab.key);
  const requestedTab = location.pathname.endsWith("/photos") ? "photos" : searchParams.get("tab");
  const requestedFocus = searchParams.get("focus");

  useEffect(() => {
    // Only auto-open the Opportunity Scope tab for the deal OWNER — that's their editing workspace.
    // A non-owner (a director/admin who can now trigger RFP office-wide) would otherwise be dropped onto
    // the scope panel, which immediately GETs the owner-only /scoping-intake route and 403s. They default
    // to Overview instead, where the Trigger RFP button + readiness gate live; the Scoping tab is still
    // reachable by an explicit click.
    const nextTab =
      requestedTab && availableTabs.includes(requestedTab as Tab)
        ? (requestedTab as Tab)
        : isOpportunityStage && viewerOwnsDeal
          ? "scoping"
          : "overview";
    setActiveTab((current) => (current === nextTab ? current : nextTab));
  }, [availableTabs, isOpportunityStage, viewerOwnsDeal, requestedTab]);

  useEffect(() => {
    if (activeTab !== "overview" || requestedFocus !== "copilot") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document.getElementById("deal-ai-copilot")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, requestedFocus]);

  useEffect(() => {
    if (!deal?.id) return;
    let cancelled = false;
    api<{ pagination: { total: number } }>(`/files/deal/${deal.id}/photos?page=1&limit=1`)
      .then((result) => {
        if (!cancelled) setPhotoCount(result.pagination.total);
      })
      .catch(() => {
        if (!cancelled) setPhotoCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deal?.id]);

  useEffect(() => {
    if (!deal?.id || !showTriggerRfpButton) {
      setRfpReadinessStatus(null);
      setRfpReadinessLoading(false);
      setRfpTriggerError(null);
      return;
    }

    let cancelled = false;
    setRfpReadinessLoading(true);
    api<{ readiness: { status: "draft" | "ready" | "activated" } }>(
      `/deals/${deal.id}/scoping-intake/readiness`
    )
      .then((result) => {
        if (!cancelled) {
          setRfpReadinessStatus(result.readiness.status);
          setRfpTriggerError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRfpReadinessStatus("draft");
          setRfpTriggerError(
            err instanceof Error ? err.message : "Could not verify Opportunity Scope readiness."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRfpReadinessLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [deal?.id, rfpReadinessRefreshKey, showTriggerRfpButton]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-64 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !deal) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Deal not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/deals")}>
          Back to Deals
        </Button>
      </div>
    );
  }
  const handleTabSelect = (tab: Tab) => {
    setActiveTab(tab);
    if (tab === "photos") {
      navigate(appendOfficeIdSearch(`/deals/${deal.id}/photos`, detailOfficeId));
      return;
    }
    if (location.pathname.endsWith("/photos")) {
      navigate(appendOfficeIdSearch(`/deals/${deal.id}?tab=${tab}`, detailOfficeId));
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", tab);
    nextParams.delete("focus");
    setSearchParams(nextParams, { replace: true });
  };

  const handleOpenProposalEditor = () => {
    setActiveTab("estimates");
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", "estimates");
    nextParams.set("mode", "proposal");
    nextParams.delete("focus");
    setSearchParams(nextParams, { replace: true });
  };

  const handleTriggerRfp = async () => {
    if (!deal || triggerRfpDisabled) return;
    setRfpTriggerError(null);
    const confirmed = window.confirm(
      "Send this deal to RFP review? This will notify the approval team and cannot be undone from this screen."
    );
    if (!confirmed) return;

    setRfpTriggering(true);
    try {
      await api(`/deals/${deal.id}/trigger-rfp`, { method: "POST" });
    } catch (err: unknown) {
      setRfpTriggerError(err instanceof Error ? err.message : "Failed to trigger RFP review.");
      setRfpTriggering(false);
      return;
    }

    toast.success("RFP request sent to approval team.");
    try {
      await refetch();
    } catch {
      toast.info("RFP triggered. Refresh page to see updated status.");
    } finally {
      setRfpTriggering(false);
    }
  };
  const handleCancelRfp = async () => {
    if (!deal?.id) return;
    if (!window.confirm("Return this deal to Opportunity and cancel the pending RFP?")) return;
    setRfpCancelling(true);
    try {
      await api(`/deals/${deal.id}/cancel-rfp`, { method: "POST" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel the RFP");
      setRfpCancelling(false);
      return;
    }
    toast.success("Returned to Opportunity");
    try {
      await refetch();
    } catch {
      toast.info("RFP cancelled. Refresh page to see updated status.");
    } finally {
      setRfpCancelling(false);
    }
  };

  const handleScopingReadinessChanged = () => {
    setRfpReadinessRefreshKey((key) => key + 1);
  };

  const slaResult = getDealDetailSlaResult(deal, currentStage, user?.role);
  const stageAgeDays = slaResult?.effectiveStageAgeDays ?? null;
  const slaCaptionLabel = getSlaCaptionLabel(slaResult);
  const slaStatusValue = getSlaStatusValue(slaResult);
  const slaCaptionContext = getSlaCaptionContext(slaResult, deal.expectedCloseDate);
  const isSlaBreached = slaResult?.isAtRisk === true;
  // Detail header value uses the deal's stage (server now provides stageSlug; fall back to the loaded
  // currentStage) so an estimating deal shows the DD-over-bid value, matching the board/list (Codex P2).
  const dealValue = resolveBestEstimate({ ...deal, stageSlug: deal.stageSlug ?? currentStage?.slug });
  const dealValueIsLost = resolveDealValueKind(deal) === "lost";
  const address = formatDealAddress(deal);
  const procoreProjectUrl = buildProcoreProjectUrl(deal.procoreProjectId);
  const shellTabs: DetailPageShellTab[] = tabs.map((tab) => ({
    id: tab.key,
    label: tab.label.replace(/\s+\(\d+\)$/, ""),
    icon: getTabIcon(tab.key),
    count:
      tab.key === "photos" && photoCount != null
        ? photoCount
        : tab.key === "team" && teamCount != null
          ? teamCount
          : tab.key === "email"
            ? deal.emailCount ?? 0
          : undefined,
  }));
  const kpis: DetailPageShellKpi[] = [
    {
      eyebrow: "Deal value",
      value: formatCurrency(dealValue.value),
      captionLabel: dealValueIsLost ? LOST_BID_VALUE_LABEL : bestEstimateCaptionLabel(dealValue.source),
      captionContext: dealValueIsLost
        ? "preserved bid -- deal was lost"
        : deal.changeOrderTotal && Number(deal.changeOrderTotal) > 0
          ? `${formatCurrency(Number(deal.changeOrderTotal))} in change orders`
          : "latest tracked value",
    },
    {
      eyebrow: "Days in stage",
      value: stageAgeDays == null ? "N/A" : `${stageAgeDays}`,
      captionLabel: slaCaptionLabel,
      captionContext: slaCaptionContext,
    },
    {
      eyebrow: "SLA status",
      value: slaStatusValue,
      captionLabel: slaCaptionLabel,
      captionContext: slaCaptionContext,
      accent: isSlaBreached ? "red" : "default",
    },
  ];
  const typeBadge = (
    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black tracking-[0.16em] text-slate-700">
      {formatDealType(deal)}
    </span>
  );
  const statusBadge = (
    <>
      {isBidBoardOwned ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-amber-700">
          <Lock className="h-3 w-3" />
          {bidBoardStageLabel(deal)}
        </span>
      ) : (
        <DealStageBadge stageId={deal.stageId} />
      )}
      {deal.onHold ? (
        <span className="inline-flex items-center rounded-full bg-slate-900 px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-white">
          On Hold
        </span>
      ) : null}
      <AtRiskBadge atRisk={deal.atRisk} />
      <ChangeOrderBadge isChangeOrder={deal.isChangeOrder} />
    </>
  );
  const headerDisplayNumber = formatDealDisplayNumber(deal);
  const subtitleSlot = (
    <>
      <span
        className="font-mono text-xs font-bold uppercase tracking-[0.14em] text-slate-500"
        data-testid="deal-detail-header-number"
      >
        {headerDisplayNumber.label}
      </span>
      {deal.parentDealId ? (
        <ChangeOrderParentLink parentDealId={deal.parentDealId} parentLabel={deal.projectNumber} />
      ) : null}
      {deal.intendedProjectNumber ? (
        <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-500">
          Intended {deal.intendedProjectNumber}
          <Info className="h-3.5 w-3.5" />
        </span>
      ) : null}
      {deal.companyId && deal.companyName ? (
        <span className="inline-flex items-center gap-2">
          <Link to={`/companies/${deal.companyId}`} className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-brand-red">
            <Building2 className="h-4 w-4" />
            {deal.companyName}
          </Link>
          <OwnerLabel ownerId={deal.companyOwnerUserId ?? null} ownerName={deal.companyOwnerUserName ?? null} />
        </span>
      ) : null}
      {address ? (
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-4 w-4" />
          {address}
        </span>
      ) : null}
      {deal.assignedRepName ? <span>Assigned to {deal.assignedRepName}</span> : null}
      <span>{stageAgeDays == null ? "Stage age unavailable" : `${stageAgeDays}d in stage`}</span>
    </>
  );
  const handleWatchToggle = async () => {
    if (!deal?.id || watchPending) return;
    setWatchPending(true);
    try {
      if (deal.isWatching) {
        await api(`/deals/${deal.id}/watch`, { method: "DELETE" });
        toast.success("Deal removed from Mine");
      } else {
        await api(`/deals/${deal.id}/watch`, { method: "POST" });
        toast.success("Deal added to Mine");
      }
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update watch state");
    } finally {
      setWatchPending(false);
    }
  };
  const actionsSlot = (
    <>
      <Button variant="outline" size="sm" onClick={handleWatchToggle} disabled={watchPending}>
        {deal.isWatching ? "Watching" : "Watch this deal"}
      </Button>
      {viewerOwnsDeal ? (
        <Button variant={deal.onHold ? "default" : "outline"} size="sm" onClick={handleHoldToggle} disabled={holdTogglePending}>
          {deal.onHold ? "Resume deal" : "Put on hold"}
        </Button>
      ) : null}
      {viewerOwnsDeal ? (
        <Link
          to={appendOfficeIdSearch(`/deals/${deal.id}/edit`, detailOfficeId)}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <Edit className="h-4 w-4" />
          Edit
        </Link>
      ) : (
        <Button variant="outline" size="sm" disabled title="Only the assigned rep can edit">
          <Edit className="h-4 w-4" />
          Edit
        </Button>
      )}
      {procoreProjectUrl ? (
        <a
          href={procoreProjectUrl}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <ExternalLink className="h-4 w-4" />
          Procore
        </a>
      ) : null}
      {showTriggerRfpButton ? (
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            onClick={handleTriggerRfp}
            disabled={triggerRfpDisabled}
            title={!isRfpScopeReady ? "Complete Opportunity Scope to enable" : undefined}
            className="h-9 rounded-md bg-brand-red px-3 text-sm font-black uppercase tracking-[0.08em] text-white shadow-sm transition hover:bg-red-700 disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none"
          >
            <Send className="mr-1 h-4 w-4" />
            {rfpTriggering ? "Sending RFP..." : "Trigger RFP"}
          </Button>
          {rfpTriggerError ? (
            <span className="max-w-64 text-right text-xs font-medium text-red-600" role="alert">
              {rfpTriggerError}
            </span>
          ) : null}
        </div>
      ) : null}
      {currentStage?.isTerminal && viewerOwnsDeal && !isBidBoardOwned && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline">Reopen Deal</Button>}
          />
          <DropdownMenuContent align="end">
            {dealStages
              .filter((s) => !s.isTerminal)
              .map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onClick={() => handleStageChange(s.id)}
                >
                  {s.name}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <TaskCreateDialog defaultDealId={deal.id} onCreated={refetch} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="icon">
            <MoreHorizontal className="h-4 w-4" />
          </Button>}
        />
        <DropdownMenuContent align="end">
          {viewerOwnsDeal ? (
            <DropdownMenuItem onClick={() => navigate(appendOfficeIdSearch(`/deals/${deal.id}/edit`, detailOfficeId))}>
              <Edit className="h-4 w-4 mr-2" />
              Edit Deal
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled title="Only the assigned rep can edit">
              <Edit className="h-4 w-4 mr-2" />
              Edit Deal
            </DropdownMenuItem>
          )}
          {/* "Move back to Opportunity" sits between Edit and Archive: amber, one step below Archive's red.
              Deliberately NOT on the PipelineProgress strip — that is the ordinary stage-click path, and
              this is not an ordinary stage change (it severs Bid Board sync and can void commission).
              Only the coarse role check lives here; the authoritative eligibility (Won/commission tier,
              change-order children, already-Opportunity) comes from the dialog's server preview, which
              renders the exact block reason rather than silently hiding the option.

              Hidden on the SHARED no-op predicate, not on the stage: the Bid Board applies backward moves,
              so it can park a still-owned — and even a signed, commission-carrying — deal on Opportunity,
              and hiding the action there left an admin unable to sever a sync that kept reclaiming it.
              `isReturnToOpportunityNoOp` is the same function the service blocks on, so the menu and the
              route cannot disagree. Commission rows are server-only knowledge; passing 0 errs toward
              OFFERING the action and letting the preview render the real verdict. */}
          {!isReturnToOpportunityNoOp({
            stageSlug: canonicalCurrentStageSlug,
            isBidBoardLinked: isDealStillBidBoardLinked,
            commissionRowCount: 0,
            effectiveContractSignedDate: deal.contractSignedDate ?? deal.contractSignedAt ?? null,
          }) && isDirectorOrAdmin ? (
            <DropdownMenuItem
              onClick={() => setReturnToOpportunityOpen(true)}
              className="text-amber-600"
            >
              <Undo2 className="h-4 w-4 mr-2" />
              Move back to Opportunity
            </DropdownMenuItem>
          ) : !isReturnToOpportunityNoOp({
              stageSlug: canonicalCurrentStageSlug,
              isBidBoardLinked: isDealStillBidBoardLinked,
              commissionRowCount: 0,
              effectiveContractSignedDate: deal.contractSignedDate ?? deal.contractSignedAt ?? null,
            }) && viewerOwnsDeal ? (
            <DropdownMenuItem disabled title="Only a director or an admin can move a deal back to Opportunity">
              <Undo2 className="h-4 w-4 mr-2" />
              Move back to Opportunity
            </DropdownMenuItem>
          ) : null}
          {canArchiveDeal({ stageSlug: deal.stageSlug ?? currentStage?.slug ?? null, assignedRepId: deal.assignedRepId }, user) ? (
            <DropdownMenuItem onClick={() => setArchiveOpen(true)} className="text-red-600">
              <Trash2 className="h-4 w-4 mr-2" />
              Archive Deal
            </DropdownMenuItem>
          ) : viewerOwnsDeal ? (
            <DropdownMenuItem disabled title="Only opportunity-stage deals can be archived — ask an admin">
              <Trash2 className="h-4 w-4 mr-2" />
              Archive Deal
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  const rail = (
    <DealRightRail
      deal={deal}
      address={address}
      procoreProjectUrl={procoreProjectUrl}
      bidBoardUrl={buildBidBoardProjectUrl(deal)}
      currentUser={user}
      officeId={detailOfficeId}
      onReassigned={refetch}
    />
  );
  const tabContent = (
    <div className="space-y-4">
      <BidDueDateBanner bidDueDate={deal.bidDueDate} />
      {/* Standing reminder, not a toast. The CRM cannot delete the Bid Board project, so the ONE manual
          step this action depends on has to survive a page reload — a single toast at move time gets
          missed and the Bid Board keeps showing a phantom active project.

          Gated on the SERVER's detachedFromLinkedProject, not on the marker alone: the action stamps
          bid_board_detached_at on any deal it moves back, including a CRM-only one that never had a Bid
          Board project. Keying on the marker would put a permanent "go delete the project" banner on a
          deal with no project, contradicting the dialog and the success toast — both of which already
          follow the same server-side linkage answer. The client cannot derive this itself: the detach
          nulls bidBoardLinkedAt and bidBoardProjectNumber by design. */}
      {deal.bidBoardDetachedAt && deal.bidBoardOwnership?.detachedFromLinkedProject ? (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="status"
        >
          <span className="font-black uppercase tracking-[0.06em]">Disconnected from Bid Board</span>
          <span className="ml-2">
            on {formatDate(deal.bidBoardDetachedAt)} — Bid Board exports no longer update this deal.
            Delete this project from the Bid Board if you have not already.
          </span>
          {buildBidBoardProjectUrl(deal) ? (
            <a
              className="ml-2 inline-flex items-center gap-1 font-semibold underline"
              href={buildBidBoardProjectUrl(deal) as string}
              target="_blank"
              rel="noreferrer"
            >
              Open in Bid Board
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      ) : null}
      {!viewerOwnsDeal ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-600">
          Assigned to {deal.assignedRepName ?? deal.assignedRepId ?? "another rep"}. You can collaborate with notes, activity, files, photos, and emails, but only the assigned rep can edit.
        </div>
      ) : null}
      <DealTimersBanner dealId={deal.id} />
      {isBidBoardOwned && bidBoardOwnership && (
        <BidBoardOwnershipBanner
          ownership={bidBoardOwnership}
          readOnlySyncedAt={deal.readOnlySyncedAt}
          onRefresh={refetch}
        />
      )}
      <RfpApprovalStatusBlock
        deal={deal}
        onRetry={handleRfpRetry}
        retrying={rfpRetrying}
        onCancel={handleCancelRfp}
        canCancel={canCancelRfp}
        cancelling={rfpCancelling}
        isOpportunityStage={isOpportunityStage}
        isBidBoardOwned={isBidBoardOwned}
        user={user}
        officeId={detailOfficeId}
      />
      {isBidBoardOwned && !deal.isHubspotSourced && <BidBoardProjectSummaryPanel deal={deal} />}
      {isEstimatingBoundaryStageSlug(currentStageSlug, workflowRoute) && !isBidBoardOwned && (
        <DealEstimatingSubstage deal={deal} onUpdate={refetch} />
      )}
      {activeTab === "overview" && (
        <div className="space-y-4">
          {isEstimatingBoundaryStageSlug(currentStageSlug, workflowRoute) && !isBidBoardOwned && (
            <DealProposalCard
              deal={deal}
              onUpdate={refetch}
              onOpenProposalEditor={handleOpenProposalEditor}
            />
          )}
          {/* Rendered for ALL deals regardless of Bid-Board ownership: accounting must be able to
              set the contract-signed date on every deal (it writes through to won_closed_date per
              #612). The backend accepts the write on any deal and the Bid-Board mirror does not
              touch contract_signed_date, so a value set on a synced deal survives re-sync. Editing
              stays role-gated (canEdit={isDirectorOrAdmin}); reps see it read-only. */}
          <DealContractSignedCard
            key={deal.id}
            deal={deal}
            canEdit={isDirectorOrAdmin}
            onUpdate={refetch}
          />
          {isBidBoardOwned && bidBoardOwnership && (
            <BidBoardReadOnlySummary ownership={bidBoardOwnership} />
          )}
          <DealOverviewTab deal={deal} officeId={detailOfficeId} onDealUpdated={refetch} />
        </div>
      )}
      {activeTab === "lead" && (
        <DealLeadTab
          deal={deal}
          isConverted={Boolean(deal.sourceLeadId)}
        />
      )}
      {activeTab === "scoping" && (
        <DealScopingWorkspace
          deal={deal}
          onDealUpdated={refetch}
          onReadinessChanged={handleScopingReadinessChanged}
          mode={isScopeReadOnlyAfterRfp ? "readonly" : "edit"}
          readOnlySubmittedAt={scopeSubmittedAt}
          canForceEdit={user?.role === "admin"}
        />
      )}
      {activeTab === "files" && <DealFileTab dealId={deal.id} />}
      {activeTab === "photos" && <DealPhotosTab dealId={deal.id} onCountChange={setPhotoCount} />}
      {activeTab === "scorecards" && <DealScorecardsTab dealId={deal.id} />}
      {activeTab === "email" && <DealEmailTab dealId={deal.id} />}
      {activeTab === "activity" && (
        <EntityActivityTab
          entityType="deal"
          entityId={deal.id}
          emptyLabel="deal"
          showRecordings
          closeTargetDate={deal.expectedCloseDate}
          onDealChanged={refetch}
          // Owner-only: the PATCH that writes expected_close_date is gated to the assigned rep on the
          // server (assertDealOwnerRouteAccess, no allowAdmin), so a non-owner admin would 403.
          canMoveCloseDate={viewerOwnsDeal}
          // Mirror the deal load (useDealDetail uses the same officeId) so a cross-office move/clear
          // targets the deal's tenant, not the viewer's active office.
          officeId={detailOfficeId}
        />
      )}
      {activeTab === "timeline" && (
        <DealTimelineTab
          dealId={deal.id}
          stageHistory={deal.stageHistory}
        />
      )}
      {activeTab === "history" && <DealHistoryTab deal={deal} />}
      {activeTab === "team" && (
        <DealTeamTab dealId={deal.id} onCountChange={setTeamCount} />
      )}
      {/* canEdit is owner-only: the deal PATCH (billingContactId) is gated by assertDealOwnerRouteAccess with
          no admin/director bypass, so a non-owner admin would get edit controls that 403 (Codex P2). */}
      {activeTab === "billing" && <DealBillingTab deal={deal} onDealUpdated={refetch} canEdit={viewerOwnsDeal} officeId={detailOfficeId} />}
      {activeTab === "estimates" && (
        <DealEstimatesTab
          dealId={deal.id}
          proposalMode={searchParams.get("mode") === "proposal"}
        />
      )}
      {activeTab === "punch_list" && <DealPunchListTab dealId={deal.id} />}
      {activeTab === "closeout" && <DealCloseoutTab dealId={deal.id} />}
    </div>
  );

  return (
    <div>
      <DetailPageShell
        parentLabel="Deals"
        parentHref="/deals"
        currentLabel={deal.name}
        iconSlot={<Briefcase className="h-9 w-9" />}
        typeBadge={typeBadge}
        statusBadge={statusBadge}
        title={deal.name}
        subtitleSlot={subtitleSlot}
        actionsSlot={actionsSlot}
        kpis={kpis}
        subheaderSlot={
          <PipelineProgress
            stages={canonicalOrderedStages}
            currentSlug={canonicalCurrentStageSlug}
            workflowRoute={workflowRoute}
            isBidBoardOwned={isBidBoardOwned}
            handoffStageDisplayOrder={handoffStage?.displayOrder ?? null}
            canMoveBackward={isDirectorOrAdmin}
            onStageClick={handleStageChange}
          />
        }
        tabs={shellTabs}
        activeTabId={activeTab}
        onTabChange={(tab) => handleTabSelect(tab as Tab)}
        rightRail={rail}
      >
        {tabContent}
      </DetailPageShell>

      {/* Stage Change Dialog */}
      {stageChangeOpen && targetStageId && (
        <StageChangeDialog
          deal={deal}
          targetStageId={targetStageId}
          officeId={detailOfficeId}
          open={stageChangeOpen}
          onOpenChange={(open) => {
            setStageChangeOpen(open);
            if (!open) setTargetStageId(null);
          }}
          onSuccess={handleStageChangeSuccess}
        />
      )}

      {/* Move back to Opportunity */}
      <ReturnToOpportunityDialog
        dealId={deal.id}
        dealName={deal.name}
        open={returnToOpportunityOpen}
        onOpenChange={setReturnToOpportunityOpen}
        onSuccess={async (result) => {
          // The Bid Board reminder is the dialog's own conditional block repeated as a toast, so it
          // follows the SERVER's wasBidBoardLinked — never assumed. A deal with no Bid Board footprint
          // gets no instruction to go delete a project that was never there.
          const bidBoardReminder = result.wasBidBoardLinked
            ? " Remember to delete it from Bid Board."
            : "";
          // Same shape, same reason, for the OTHER external side effect this action cannot undo: if the
          // RFP had already gone to SyncHub (or a delivery was mid-flight), the submission outlives the
          // cycle we just cleared and only the operator can cancel it there. Server-decided, like the
          // Bid Board clause — the page never guesses.
          const rfpReminder = result.rfpSubmissionMayExist
            ? " An RFP submission may still exist in SyncHub — cancel it there."
            : "";
          toast.success(
            result.commissionRowsVoided > 0
              ? `Moved back to Opportunity — ${result.commissionRowsVoided} commission row(s) voided.${bidBoardReminder}${rfpReminder}`
              : `Moved back to Opportunity.${bidBoardReminder}${rfpReminder}`
          );
          // Keep the move's success separate from a later refetch failure: the write already committed,
          // so a failed reload is a "refresh the page" hint, never a "the move failed" error.
          try {
            await refetch();
          } catch {
            toast.info("Moved back to Opportunity. Refresh the page to see the updated deal.");
          }
        }}
      />

      {/* Archive Deal Dialog */}
      <Dialog open={archiveOpen} onOpenChange={(open) => { if (!archiving) setArchiveOpen(open); }}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Archive deal</DialogTitle>
            <DialogDescription>
              This archives the deal and removes it from active lists (it appears under Status → Archived). The reason below is added to the top of the deal description.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Textarea
              placeholder="Why are you archiving this deal?"
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setArchiveOpen(false)}
              disabled={archiving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleArchiveSubmit}
              disabled={archiving || archiveReason.trim().length === 0}
            >
              {archiving ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DealRightRail({
  deal,
  address,
  procoreProjectUrl,
  bidBoardUrl,
  currentUser,
  officeId,
  onReassigned,
}: {
  deal: DealDetail;
  address: string;
  procoreProjectUrl: string | null;
  bidBoardUrl: string | null;
  currentUser: { id?: string | null; role?: string | null; activeOfficeId?: string | null; officeId?: string | null } | null | undefined;
  officeId?: string | null;
  onReassigned: () => void | Promise<void>;
}) {
  const canReassignDeal =
    currentUser?.role === "admin" ||
    currentUser?.role === "director" ||
    (Boolean(currentUser?.id) && currentUser?.id === deal.assignedRepId);
  const { salesReps, loading: salesRepsLoading } = useSalesReps(
    officeId ?? currentUser?.activeOfficeId ?? currentUser?.officeId ?? undefined,
    { purpose: "deal-reassignment", enabled: canReassignDeal }
  );
  // The sales-source picker uses the "sales-source" feed (internal CRM users — any role except
  // field_contractor, matching assertSalesSourceIsCrmUser). It happens to match the deal-reassignment
  // roster today, but keep the dedicated purpose so the intent (and any future divergence) stays explicit.
  // Loaded separately + gated to leadership (admin/director, == canEditSalesSource) so a rep viewing the
  // page issues no extra fetch.
  const { salesReps: sourceSalesReps, loading: sourceSalesRepsLoading } = useSalesReps(
    officeId ?? currentUser?.activeOfficeId ?? currentUser?.officeId ?? undefined,
    {
      purpose: "sales-source",
      enabled: currentUser?.role === "admin" || currentUser?.role === "director",
    }
  );
  const [reassigning, setReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const assignedRep = formatNullable(deal.assignedRepName ?? deal.assignedRepId);
  const assignedRepInitials = initials(deal.assignedRepName ?? deal.assignedRepId ?? "NA");
  const assignedRepColor = getOwnerInitialColor(deal.assignedRepId ?? deal.assignedRepName);
  // Exclude the current sales source — the server rejects reassigning the owner to it (SALES_SOURCE_CONFLICT).
  const ownerOptions = buildRepOptions(salesReps, {
    excludeIds: [deal.salesSourceUserId],
    currentId: deal.assignedRepId,
    currentServerName: deal.assignedRepName,
    fallbackLabel: "Current assigned rep",
  });

  async function handleReassign(nextRepId: string) {
    if (!nextRepId || nextRepId === deal.assignedRepId || reassigning) return;
    setReassigning(true);
    setReassignError(null);
    try {
      await apiUpdateDeal(deal.id, { assignedRepId: nextRepId });
      toast.success("Deal owner updated");
      await onReassigned();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reassign deal";
      setReassignError(message);
      toast.error(message);
    } finally {
      setReassigning(false);
    }
  }

  // Estimator editing is leadership-only (matches the dedicated PATCH /deals/:id/estimator RBAC).
  // The picker reuses the already-loaded sales-rep list (that endpoint returns all active CRM users
  // incl. estimators); when editing is allowed (admin/director) salesReps is guaranteed loaded
  // because canReassignDeal is a superset of canEditEstimator.
  const canEditEstimator = currentUser?.role === "admin" || currentUser?.role === "director";
  // P1: the estimator is READ-ONLY on a Bid Board-owned deal. The server is authoritative — it 409s
  // (BID_BOARD_OWNED_ESTIMATOR_LOCKED) because the next Bid Board mirror overwrites estimator_user_id
  // directly with no commission re-attribution, so a manual pick here would desync the dsc row. Mirror the
  // page's ownership notion (the is_bid_board_owned column OR inferred ownership) used to hide every other
  // edit control, so the estimator picker is hidden on the SAME deals and never renders an editable control
  // the sync would clobber. Client is at worst slightly more conservative than the column-only server gate.
  const estimatorBidBoardOwned = Boolean(deal.isBidBoardOwned || deal.bidBoardOwnership?.isOwned);
  const [savingEstimator, setSavingEstimator] = useState(false);
  const [estimatorError, setEstimatorError] = useState<string | null>(null);
  const estimatorName = formatNullable(deal.estimatorUserName ?? deal.estimatorUserId);
  // Exclude the current sales source — the server rejects an estimator == sales source (SALES_SOURCE_CONFLICT).
  const estimatorOptions = buildRepOptions(salesReps, {
    excludeIds: [deal.salesSourceUserId],
    currentId: deal.estimatorUserId,
    currentServerName: deal.estimatorUserName,
    fallbackLabel: "Current estimator",
  });

  async function handleEstimatorChange(nextIdRaw: string) {
    const nextId = nextIdRaw || null;
    if (nextId === (deal.estimatorUserId ?? null) || savingEstimator) return;
    setSavingEstimator(true);
    setEstimatorError(null);
    try {
      // Mirror the deal record load (useDealDetail above passes the same `officeId`): a cross-office
      // estimator edit must target the office the deal was read from, not the viewer's active office.
      await apiUpdateDealEstimator(deal.id, nextId, { officeId });
      toast.success(nextId ? "Estimator updated" : "Estimator cleared");
      // FINDING 3 (Codex): the post-save refetch is isolated in its OWN try/catch (mirrors handleHoldToggle)
      // so a refetch failure can NEVER surface as a save error — the estimator PATCH already succeeded. The
      // outer catch reflects ONLY the PATCH result; a failed refetch just soft-warns the user to reload.
      try {
        await onReassigned();
      } catch {
        toast.info("Estimator updated. Refresh the page to see the latest detail state.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update estimator";
      setEstimatorError(message);
      toast.error(message);
    } finally {
      setSavingEstimator(false);
    }
  }

  // Sales Source editing is leadership-only (matches the PATCH /deals/:id/sales-source RBAC).
  // Reuses the same canEditEstimator condition; the picker is fed by the sales-source sourceSalesReps feed.
  const canEditSalesSource = canEditEstimator;
  const [savingSalesSource, setSavingSalesSource] = useState(false);
  const [salesSourceError, setSalesSourceError] = useState<string | null>(null);
  // Exclude the owner + estimator from the source picker (the server rejects those with 422); mirrors
  // the create form's exclusion so a leader can't pick a conflicting source and only learn via a toast.
  // Built from sourceSalesReps (internal CRM users only) so a leader is never offered an external
  // field_contractor that would 422.
  const salesSourceOptions = buildRepOptions(sourceSalesReps, {
    excludeIds: [deal.assignedRepId, deal.estimatorUserId],
    currentId: deal.salesSourceUserId,
    currentServerName: deal.salesSourceUserName,
    fallbackLabel: "Current sales source",
  });
  // Prefer the server-provided name so a deactivated source rep doesn't show a raw UUID.
  // Mirrors how estimatorUserName is used for the estimator read-only display above.
  const salesSourceName =
    deal.salesSourceUserName ??
    salesReps.find((r) => r.id === deal.salesSourceUserId)?.displayName ??
    (deal.salesSourceUserId ? deal.salesSourceUserId : null);

  async function handleSalesSourceChange(nextIdRaw: string) {
    const nextId = nextIdRaw || null;
    if (nextId === (deal.salesSourceUserId ?? null) || savingSalesSource) return;
    setSavingSalesSource(true);
    setSalesSourceError(null);
    try {
      await apiUpdateDealSalesSource(deal.id, nextId, { officeId });
      toast.success(nextId ? "Sales source updated" : "Sales source cleared");
      try {
        await onReassigned();
      } catch {
        toast.info("Sales source updated. Refresh the page to see the latest detail state.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update sales source";
      setSalesSourceError(message);
      toast.error(message);
    } finally {
      setSavingSalesSource(false);
    }
  }

  const headerDisplayNumber = formatDealDisplayNumber(deal);
  const dealWithOptionalContact = deal as DealDetail & {
    primaryContactName?: string | null;
    primaryContactTitle?: string | null;
    primaryContact?: { name?: string | null; title?: string | null } | null;
    propertyName?: string | null;
  };
  const primaryContactName =
    dealWithOptionalContact.primaryContactName ??
    dealWithOptionalContact.primaryContact?.name ??
    null;
  const primaryContactTitle =
    dealWithOptionalContact.primaryContactTitle ??
    dealWithOptionalContact.primaryContact?.title ??
    null;
  const propertyName = dealWithOptionalContact.propertyName ?? (address || "Open property");

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <DetailRailSection title="Owner">
          <DetailRailItem
            label="Assigned rep"
            value={
              <div className="space-y-2">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="grid h-8 w-8 place-items-center rounded-full text-[10px] font-black uppercase text-white"
                    style={{ backgroundColor: assignedRepColor.backgroundColor, color: assignedRepColor.textColor }}
                  >
                    {assignedRepInitials}
                  </span>
                  <span>{assignedRep}</span>
                </span>
                {canReassignDeal ? (
                  <div className="space-y-1">
                    <select
                      aria-label="Reassign deal owner"
                      className="h-8 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-900"
                      disabled={salesRepsLoading || reassigning || ownerOptions.length === 0}
                      value={deal.assignedRepId ?? ""}
                      onChange={(event) => {
                        void handleReassign(event.currentTarget.value);
                      }}
                    >
                      {ownerOptions.length === 0 ? (
                        <option value={deal.assignedRepId ?? ""}>
                          {salesRepsLoading ? "Loading reps..." : assignedRep}
                        </option>
                      ) : (
                        ownerOptions.map((rep) => (
                          <option key={rep.id} value={rep.id}>
                            {rep.displayName}
                          </option>
                        ))
                      )}
                    </select>
                    {reassignError ? <p className="text-xs font-medium text-red-600">{reassignError}</p> : null}
                  </div>
                ) : null}
              </div>
            }
          />
          <DetailRailItem
            label="Estimator"
            value={
              // FINDING 2 (Codex): a change order's estimator is INHERITED from the parent deal and the server
              // 409s (CHANGE_ORDER_FIELD_LOCKED) on any edit, so never render an editable picker on a CO —
              // show the resolved estimator read-only with an inherited note. The editable picker stays gated
              // on (canEditEstimator && !deal.isChangeOrder) via this short-circuit.
              deal.isChangeOrder ? (
                <div className="space-y-1">
                  <span>{estimatorName}</span>
                  <p className="text-xs italic text-slate-500">
                    Inherited from the parent deal.
                  </p>
                </div>
              ) : estimatorBidBoardOwned && !deal.estimatorUserId ? (
                // P1 (narrowed): on a Bid Board-owned deal the sync OWNS the INITIAL estimator — the server
                // 409s (BID_BOARD_OWNED_ESTIMATOR_LOCKED) only on the FIRST fill. While none is set yet, show
                // read-only with a managed-by-sync note. Once the sync has set one, the picker below becomes
                // editable so a director can CORRECT it (#741's empties-only sync keeps the correction stuck).
                <div className="space-y-1">
                  <span>{estimatorName}</span>
                  <p className="text-xs italic text-slate-500">
                    The initial estimator is set by the Bid Board sync.
                  </p>
                </div>
              ) : canEditEstimator ? (
                <div className="space-y-1">
                  <select
                    aria-label="Edit estimator"
                    className="h-8 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-900"
                    disabled={salesRepsLoading || savingEstimator}
                    value={deal.estimatorUserId ?? ""}
                    onChange={(event) => {
                      void handleEstimatorChange(event.currentTarget.value);
                    }}
                  >
                    <option value="">— None —</option>
                    {estimatorOptions.map((rep) => (
                      <option key={rep.id} value={rep.id}>
                        {rep.displayName}
                      </option>
                    ))}
                  </select>
                  {estimatorError ? (
                    <p className="text-xs font-medium text-red-600">{estimatorError}</p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-1">
                  <span>{estimatorName}</span>
                  <p className="text-xs italic text-slate-500">
                    Only admins and directors can edit the estimator.
                  </p>
                </div>
              )
            }
          />
          {/* F3c: Sales source is a service-opportunity-only concept. Hide on capX/normal deals.
               Change orders are exempted: a CO may inherit a source from a service-deal parent
               and should still display that read-only value even if the CO's own workflowRoute
               resolves differently (the CO branch is always read-only regardless). */}
          {(deal.isChangeOrder === true || deal.workflowRoute === "service") && (
            <DetailRailItem
              label="Sales Source"
              value={
                // Change orders inherit their sales source from the parent deal — no own source to set.
                deal.isChangeOrder ? (
                  <div className="space-y-1">
                    <span>{salesSourceName ?? "Not set"}</span>
                    <p className="text-xs italic text-slate-500">
                      Inherited from the parent deal.
                    </p>
                  </div>
                ) : canEditSalesSource ? (
                  <div className="space-y-1">
                    <select
                      aria-label="Edit sales source"
                      className="h-8 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-900"
                      // Watch the sales-source feed's own loading flag (it populates salesSourceOptions),
                      // NOT the deal-reassignment salesRepsLoading — else the picker could go interactive
                      // with a stale/empty list before its own fetch resolves.
                      disabled={sourceSalesRepsLoading || savingSalesSource}
                      value={deal.salesSourceUserId ?? ""}
                      onChange={(event) => {
                        void handleSalesSourceChange(event.currentTarget.value);
                      }}
                    >
                      <option value="">— None —</option>
                      {salesSourceOptions.map((rep) => (
                        <option key={rep.id} value={rep.id}>
                          {rep.displayName}
                        </option>
                      ))}
                    </select>
                    {salesSourceError ? (
                      <p className="text-xs font-medium text-red-600">{salesSourceError}</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <span>{salesSourceName ?? "Not set"}</span>
                    <p className="text-xs italic text-slate-500">
                      Only admins and directors can edit the sales source.
                    </p>
                  </div>
                )
              }
            />
          )}
        </DetailRailSection>

        <DetailRailSection title="Account">
          <DetailRailItem
            label="Company"
            value={
              deal.companyId && deal.companyName ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Link to={`/companies/${deal.companyId}`} className="text-brand-red hover:underline">
                    {deal.companyName}
                  </Link>
                  <OwnerLabel ownerId={deal.companyOwnerUserId ?? null} ownerName={deal.companyOwnerUserName ?? null} />
                </span>
              ) : (
                <span className="text-slate-500">Unassigned</span>
              )
            }
          />
        </DetailRailSection>

        <DetailRailSection title="Property">
          <DetailRailItem
            label="Property"
            value={
              deal.propertyId ? (
                <Link to={`/properties/${deal.propertyId}`} className="text-brand-red hover:underline">
                  {propertyName}
                </Link>
              ) : (
                <span className="text-slate-500">{address || "No property linked"}</span>
              )
            }
          />
          {address ? <DetailRailItem label="Address" value={address} /> : null}
        </DetailRailSection>

        <DetailRailSection title="Primary Contact">
          <DetailRailItem
            label="Contact"
            value={
              deal.primaryContactId ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Link to={`/contacts/${deal.primaryContactId}`} className="text-brand-red hover:underline">
                    {primaryContactName ?? "Unknown contact"}
                  </Link>
                  <OwnerLabel
                    ownerId={deal.primaryContactOwnerUserId ?? null}
                    ownerName={deal.primaryContactOwnerUserName ?? null}
                  />
                </span>
              ) : (
                <span className="text-slate-500">No primary contact</span>
              )
            }
          />
          {primaryContactTitle ? <DetailRailItem label="Title" value={primaryContactTitle} /> : null}
        </DetailRailSection>

        <DetailRailSection title="Project Type">
          <DetailRailItem label="Type" value={formatDealType(deal)} />
          <DetailRailItem label="Source" value={formatNullable(deal.source ? titleCase(deal.source) : null)} />
          <DetailRailItem label="Workflow" value={titleCase(deal.workflowRoute ?? "normal")} />
        </DetailRailSection>

        <DetailRailSection title="Project Number">
          <DetailRailItem
            label="Project number"
            value={
              deal.projectNumber ? (
                <span className="font-mono">{deal.projectNumber}</span>
              ) : (
                <span className="space-y-1">
                  <span className="block font-mono text-slate-500">{headerDisplayNumber.label}</span>
                  <span className="block text-xs font-medium text-slate-400">Not yet assigned</span>
                </span>
              )
            }
          />
          {deal.intendedProjectNumber ? (
            <DetailRailItem label="Intended" value={<span className="font-mono">{deal.intendedProjectNumber}</span>} />
          ) : null}
          <DetailRailItem label="Close target" value={formatDateOnly(deal.expectedCloseDate)} />
        </DetailRailSection>

        <DetailRailSection title="System references">
          <DetailRailItem
            label="Deal reference"
            value={
              <span className="font-mono text-xs" data-testid="deal-detail-system-id">
                {headerDisplayNumber.label}
              </span>
            }
          />
          <DetailRailItem
            label="Procore project"
            value={
              <span className="space-y-1">
                <span className="block font-mono text-xs">{formatNullable(deal.procoreProjectId)}</span>
                {procoreProjectUrl ? (
                  <a
                    href={procoreProjectUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-[0.12em] text-brand-red hover:underline"
                  >
                    Open in Procore
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </span>
            }
          />
          <DetailRailItem
            label="Procore company"
            value={<span className="font-mono text-xs">{formatNullable(deal.procoreCompanyId)}</span>}
          />
          <DetailRailItem
            label="Procore bid"
            value={
              <span className="space-y-1">
                <span className="block font-mono text-xs">{formatNullable(deal.procoreBidId)}</span>
                {bidBoardUrl ? (
                  <a
                    href={bidBoardUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-[0.12em] text-brand-red hover:underline"
                  >
                    Open in Bid Board
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </span>
            }
          />
          <DetailRailItem
            label="Bid Board #"
            value={<span className="font-mono text-xs">{formatNullable(deal.bidBoardProjectNumber)}</span>}
          />
        </DetailRailSection>
      </CardContent>
    </Card>
  );
}

function RfpApprovalStatusBlock({
  deal,
  onRetry,
  retrying,
  onCancel,
  canCancel,
  cancelling,
  isOpportunityStage,
  isBidBoardOwned,
  user,
  officeId,
}: {
  deal: DealDetail;
  onRetry: () => void;
  retrying: boolean;
  onCancel?: () => void;
  canCancel?: boolean;
  cancelling?: boolean;
  // Page-derived gating (canonicalCurrentStageSlug with currentStage fallback; isBidBoardOwned incl.
  // inferred bidBoardOwnership.isOwned), so the cancel button matches how the rest of the page gates
  // actions and doesn't lose the escape hatch when raw deal.stageSlug is absent / expose it on an
  // inferred Bid Board owned deal.
  isOpportunityStage: boolean;
  isBidBoardOwned: boolean;
  user: ReturnType<typeof useAuth>["user"];
  officeId: string | null;
}) {
  if (!deal.rfpApprovalStatus) return null;

  const conflictSummary =
    deal.rfpConflictWith && typeof deal.rfpConflictWith === "object"
      ? Object.entries(deal.rfpConflictWith)
          .slice(0, 3)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join(", ")
      : null;

  const states = {
    pending_outbox: {
      tone: "border-sky-200 bg-sky-50 text-sky-950",
      label: "RFP being sent to approvers",
    },
    pending: {
      tone: "border-blue-200 bg-blue-50 text-blue-950",
      label: "RFP under review",
    },
    approved: {
      tone: "border-emerald-200 bg-emerald-50 text-emerald-950",
      label: "RFP approved",
    },
    declined: {
      tone: "border-slate-200 bg-slate-50 text-slate-950",
      label: "RFP declined",
    },
    conflict: {
      tone: "border-yellow-300 bg-yellow-50 text-yellow-950",
      label: "RFP request conflict",
    },
    cancelled_source_ineligible: {
      tone: "border-orange-300 bg-orange-50 text-orange-950",
      label: "RFP cancelled - eligibility check failed",
    },
    send_failed: {
      tone: "border-red-300 bg-red-50 text-red-950",
      label: "RFP delivery failed",
    },
  } as const;
  const fallbackState = {
    tone: "border-slate-200 bg-slate-50 text-slate-950",
    label: "Unknown RFP status",
  } as const;
  const state = states[deal.rfpApprovalStatus as keyof typeof states] ?? fallbackState;

  if (!(deal.rfpApprovalStatus in states)) {
    console.warn("Unknown RFP status on deal detail page", {
      dealId: deal.id,
      rfpApprovalStatus: deal.rfpApprovalStatus,
    });
  }

  return (
    <section className={`rounded-lg border p-3 ${state.tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{state.label}</p>
          {deal.rfpApprovalStatus === "conflict" && (
            <p className="mt-1 text-sm">
              {[deal.rfpConflictReason, conflictSummary].filter(Boolean).join(" - ")}
            </p>
          )}
          {deal.rfpApprovalStatus === "send_failed" && deal.rfpLastAttemptError && (
            <p className="mt-1 text-sm">{deal.rfpLastAttemptError}</p>
          )}
          {deal.rfpApprovalStatus === "pending" && deal.rfpApprovalRequestId && (
            <p className="mt-1 text-sm">Request #{deal.rfpApprovalRequestId}</p>
          )}
          {deal.rfpApprovalStatus === "declined" && deal.rfpDeclinedReason && (
            <p className="mt-1 text-sm">{deal.rfpDeclinedReason}</p>
          )}
          {deal.rfpApprovalStatus === "declined" && deal.rfpDeclinedAt && (
            <p className="mt-1 text-sm">Declined {formatDate(deal.rfpDeclinedAt)}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {deal.rfpApprovalStatus === "send_failed" && (
            <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
              {retrying ? "Retrying..." : "Retry"}
            </Button>
          )}
          {canCancel &&
            // Mirror the cancel route's full guard so the button only shows when the deal is actually
            // cancellable: still an Opportunity-family stage, not Bid Board owned, in an attention state,
            // and neither a re-confirmed denial nor an in-flight override approval. Otherwise the route
            // rejects (RFP_CANCEL_WRONG_STATE / NOT_CANCELLABLE) and the action can only 409. Stage +
            // ownership come from the page-derived values (currentStage fallback + inferred ownership).
            isOpportunityStage &&
            !isBidBoardOwned &&
            pendingRfpSubStateForStatus(deal.rfpApprovalStatus) === "attention" &&
            deal.rfpOverrideDecision !== "denial_reconfirmed" &&
            deal.rfpOverrideState !== "approving" && (
              <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={cancelling}>
                {cancelling ? "Cancelling..." : "Return to Opportunity"}
              </Button>
            )}
        </div>
      </div>
      <RfpVotePanel deal={deal} user={user} officeId={officeId} />
    </section>
  );
}

function BidBoardProjectSummaryPanel({ deal }: { deal: DealDetail }) {
  const bidBoardUrl = buildBidBoardProjectUrl(deal);
  // Assigned PM is populated later by Procore role polling; Bid Board exports do not carry this field.
  const assignedPm = deal.bidBoardAssignedPm || "Not yet assigned";

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Bid Board summary</h3>
          <p className="mt-1 text-xs text-slate-500">Read-only project status mirrored from Bid Board.</p>
        </div>
        <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
          Managed by Bid Board
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Stage</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{bidBoardStageLabel(deal)}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Estimate</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">
            {formatBidBoardEstimate(deal.bidBoardTotalSales)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Last synced</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">
            synced {bidBoardSyncTimeAgo(deal.bidBoardLastUpdatedAt)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">Assigned PM</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{assignedPm}</p>
        </div>
      </div>

      {bidBoardUrl && (
        <a
          href={bidBoardUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center justify-center gap-2 rounded-md bg-brand-red px-3 py-2 text-sm font-medium text-white hover:bg-brand-red/90"
        >
          Open in Bid Board
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </section>
  );
}

function BidBoardOwnershipBanner({
  ownership,
  readOnlySyncedAt,
  onRefresh,
}: {
  ownership: NonNullable<DealDetail["bidBoardOwnership"]>;
  readOnlySyncedAt: string | null;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-amber-200 p-2">
          <Lock className="h-4 w-4" />
        </div>
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Bid Board now owns downstream progression</h3>
            <p className="mt-1 text-sm">{ownership.message}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">
              Synced from Bid Board {bidBoardSyncTimeAgo(readOnlySyncedAt)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 border-amber-400 bg-white/70 px-2 text-xs text-amber-950 hover:bg-white"
              onClick={onRefresh}
            >
              Refresh
              <span className="sr-only"> Bid Board sync status</span>
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                Still editable in CRM
              </p>
              <p className="mt-1 text-sm">{ownership.canEditInCrm.join(", ")}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                Mirrored from Bid Board
              </p>
              <p className="mt-1 text-sm">{ownership.mirroredInCrm.join(", ")}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function BidBoardReadOnlySummary({
  ownership,
}: {
  ownership: NonNullable<DealDetail["bidBoardOwnership"]>;
}) {
  return (
    <section className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-700">
      <p className="font-medium text-slate-900">Downstream stage controls are read-only in CRM.</p>
      <p className="mt-1">
        Bid Board owns stage progression, proposal status, and estimating progress after the
        estimating handoff.
      </p>
      <p className="mt-2">
        Keep using CRM for {ownership.canEditInCrm.join(", ")}.
      </p>
    </section>
  );
}

export function DealScopingReadOnlyPanel({
  ownership,
  onOpenTab,
}: {
  ownership: NonNullable<DealDetail["bidBoardOwnership"]>;
  onOpenTab: (tab: Tab) => void;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-200 p-2">
            <Lock className="h-4 w-4" />
          </div>
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">Opportunity scope is now read-only in CRM</h3>
              <p className="mt-1 text-sm">{ownership.message}</p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                  Keep working in CRM
                </p>
                <p className="mt-1 text-sm">{ownership.canEditInCrm.join(", ")}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                  Mirrored from Bid Board
                </p>
                <p className="mt-1 text-sm">{ownership.mirroredInCrm.join(", ")}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenTab("overview")}>
                Open Overview
              </Button>
              <Button variant="outline" size="sm" onClick={() => onOpenTab("files")}>
                Open Files
              </Button>
              <Button variant="outline" size="sm" onClick={() => onOpenTab("activity")}>
                Open Activity
              </Button>
              <Button variant="outline" size="sm" onClick={() => onOpenTab("team")}>
                Open Team
              </Button>
            </div>
          </div>
        </div>
      </section>

      <BidBoardReadOnlySummary ownership={ownership} />
    </div>
  );
}

function DealLeadTab({
  deal,
  isConverted,
}: {
  deal: DealDetail;
  isConverted: boolean;
}) {
  const navigate = useNavigate();
  const { lead, loading, error } = useLeadDetail(deal.sourceLeadId ?? undefined);

  if (!deal.sourceLeadId) {
    return (
      <div className="rounded-lg border bg-muted/30 p-6">
        <h3 className="text-sm font-semibold">No Source Lead</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          This legacy deal was not converted from a lead, so there is no lead record to show here.
        </p>
      </div>
    );
  }

  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg bg-muted" />;
  }

  if (error || !lead) {
    return (
      <div className="rounded-lg border bg-muted/30 p-6">
        <h3 className="text-sm font-semibold">Source Lead Unavailable</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {error ?? "The source lead could not be loaded."}
        </p>
        <Button className="mt-4" variant="outline" onClick={() => navigate(`/leads/${deal.sourceLeadId}`)}>
          Open Source Lead
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
      <div className="space-y-3">
        <Button variant="outline" onClick={() => navigate(`/leads/${deal.sourceLeadId}`)}>
          View Source Lead
        </Button>
        <LeadForm
          lead={{
            ...lead,
            propertyName: lead.property?.name ?? null,
            propertyAddress: lead.property?.address ?? null,
            propertyCity: lead.property?.city ?? null,
            propertyState: lead.property?.state ?? null,
            propertyZip: lead.property?.zip ?? null,
          }}
          converted={isConverted}
        />
      </div>

      <LeadTimelineTab
        leadId={deal.sourceLeadId ?? deal.id}
        convertedDealId={isConverted ? deal.id : null}
        convertedAt={isConverted ? deal.stageEnteredAt : null}
      />
    </div>
  );
}
