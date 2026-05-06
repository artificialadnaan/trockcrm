import { useState, useCallback, useEffect } from "react";
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  Edit,
  Trash2,
  ChevronRight,
  Info,
  MoreHorizontal,
  Lock,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { DealEmailTab } from "@/components/email/deal-email-tab";
import { RecordingList } from "@/components/call-recordings/recording-list";
import { DealOverviewTab } from "@/components/deals/deal-overview-tab";
import { DealHistoryTab } from "@/components/deals/deal-history-tab";
import { DealTimelineTab } from "@/components/deals/deal-timeline-tab";
import { DealScopingWorkspace } from "@/components/deals/deal-scoping-workspace";
import { DealFileTab } from "@/components/files/deal-file-tab";
import { DealPhotosTab } from "./deal-photos-tab";
import { DealTeamTab } from "./deal-team-tab";
import { DealEstimatesTab } from "./deal-estimates-tab";
import { DealPunchListTab } from "./deal-punch-list-tab";
import { DealCloseoutTab } from "./deal-closeout-tab";
import { DealTimersBanner } from "./deal-timers-banner";
import { DealProposalCard } from "./deal-proposal-card";
import { DealContractSignedCard } from "./deal-contract-signed-card";
import { DealEstimatingSubstage } from "./deal-estimating-substage";
import { LeadForm } from "@/components/leads/lead-form";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { ActivityLogForm } from "@/components/activities/activity-log-form";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import { useActivities, createActivity } from "@/hooks/use-activities";
import { useDealDetail, deleteDeal as apiDeleteDeal, type DealDetail } from "@/hooks/use-deals";
import { useLeadDetail } from "@/hooks/use-leads";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { formatCurrency, bestEstimate } from "@/lib/deal-utils";
import {
  getCanonicalDealStageSlugs,
  getDealStageLabelBySlug,
  isEstimatingBoundaryStageSlug,
  isSelectableDealStageSlug,
  normalizeDealStageSlug,
} from "@/lib/pipeline-ownership";
import {
  getCanonicalEstimatingBoundaryStageSlug,
  toCanonicalDealStageSlug,
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
  if (!deal.procoreCompanyId || !deal.procoreBidId) return null;
  return `https://us02.procore.com/webclients/host/companies/${deal.procoreCompanyId}/tools/bid-board/project/${deal.procoreBidId}/details`;
}

type Tab = "overview" | "lead" | "scoping" | "files" | "photos" | "email" | "activity" | "timeline" | "history" | "team" | "estimates" | "punch_list" | "closeout";

function isBidBoardManagedStage(
  stage: { slug: string; displayOrder: number },
  options: {
    isBidBoardOwned: boolean;
    workflowRoute: "normal" | "service";
    handoffStageDisplayOrder: number | null;
  }
) {
  if (!options.isBidBoardOwned) {
    return false;
  }

  if (options.handoffStageDisplayOrder == null) {
    return !isEstimatingBoundaryStageSlug(stage.slug, options.workflowRoute);
  }

  return (
    !isEstimatingBoundaryStageSlug(stage.slug, options.workflowRoute) &&
    stage.displayOrder > options.handoffStageDisplayOrder
  );
}

export function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { deal, loading, error, refetch } = useDealDetail(id);
  const { stages } = usePipelineStages();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [targetStageId, setTargetStageId] = useState<string | null>(null);
  const [teamCount, setTeamCount] = useState<number | null>(null);
  const [photoCount, setPhotoCount] = useState<number | null>(null);
  const [rfpRetrying, setRfpRetrying] = useState(false);
  const currentStage = stages.find((s) => s.id === deal?.stageId);
  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";
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
  const canonicalStageOrder = new Map(
    canonicalStageSlugs.map((slug, index) => [slug, index] as const)
  );
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

  // Build stage advancement options
  const canonicalCurrentStageSlug =
    currentStage == null ? null : toCanonicalDealStageSlug(currentStage.slug, workflowRoute);
  const currentCanonicalIndex =
    canonicalCurrentStageSlug == null ? -1 : (canonicalStageOrder.get(canonicalCurrentStageSlug) ?? -1);
  const forwardStages =
    currentCanonicalIndex === -1
      ? []
      : canonicalOrderedStages.filter(
          (stage) => (canonicalStageOrder.get(stage.slug) ?? -1) > currentCanonicalIndex
        );
  const backwardStages =
    currentCanonicalIndex <= 0
      ? []
      : canonicalOrderedStages.filter((stage) => {
          const stageIndex = canonicalStageOrder.get(stage.slug) ?? -1;
          return stageIndex > -1 && stageIndex < currentCanonicalIndex && !stage.isTerminal;
        });
  const handoffStageSlug =
    bidBoardOwnership?.handoffStageSlug ?? getCanonicalEstimatingBoundaryStageSlug(workflowRoute);
  const handoffStage =
    canonicalOrderedStages.find((s) => s.slug === handoffStageSlug) ??
    canonicalOrderedStages.find((s) => isEstimatingBoundaryStageSlug(s.slug, workflowRoute));
  const readonlyForwardStages = forwardStages.filter((stage) =>
    isBidBoardManagedStage(stage, {
      isBidBoardOwned,
      workflowRoute,
      handoffStageDisplayOrder: handoffStage?.displayOrder ?? null,
    })
  );
  const manualForwardStages = forwardStages.filter((stage) =>
    !isBidBoardManagedStage(stage, {
      isBidBoardOwned,
      workflowRoute,
      handoffStageDisplayOrder: handoffStage?.displayOrder ?? null,
    })
  );

  const handleStageChange = (stageId: string) => {
    setTargetStageId(stageId);
    setStageChangeOpen(true);
  };

  const handleStageChangeSuccess = () => {
    setStageChangeOpen(false);
    setTargetStageId(null);
    refetch();
  };

  const handleDelete = async () => {
    if (!deal) {
      return;
    }
    if (!window.confirm("Are you sure you want to delete this deal? This action can be undone by an admin.")) {
      return;
    }
    try {
      await apiDeleteDeal(deal.id);
      navigate("/deals");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete deal");
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

  const currentStageSlug = currentStage?.slug ?? "";
  const isOpportunityStage = canonicalCurrentStageSlug === "opportunity";
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
    { key: "email", label: "Email" },
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
    const nextTab =
      requestedTab && availableTabs.includes(requestedTab as Tab)
        ? (requestedTab as Tab)
        : isOpportunityStage
          ? "scoping"
          : "overview";
    setActiveTab((current) => (current === nextTab ? current : nextTab));
  }, [availableTabs, isOpportunityStage, requestedTab]);

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
      navigate(`/deals/${deal.id}/photos`);
      return;
    }
    if (location.pathname.endsWith("/photos")) {
      navigate(`/deals/${deal.id}?tab=${tab}`);
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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-1 -ml-2"
            onClick={() => navigate("/deals")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Deals
          </Button>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold">{deal.name}</h2>
            <span className="text-sm text-muted-foreground font-mono">
              {deal.dealNumber}
            </span>
          </div>
          {deal.intendedProjectNumber ? (
            <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="font-mono">Intended: {deal.intendedProjectNumber}</span>
              <Info
                className="h-3.5 w-3.5"
                aria-label="The deal number stays fixed because downstream systems (SyncHub, Procore, Bid Board) reference it. The intended number reflects the current project type."
              >
                <title>
                  The deal number stays fixed because downstream systems (SyncHub, Procore, Bid Board) reference it. The intended number reflects the current project type.
                </title>
              </Info>
            </div>
          ) : null}
          <div className="flex items-center gap-3 mt-1">
            {isBidBoardOwned ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-sm font-medium text-slate-700">
                <Lock className="h-3.5 w-3.5" />
                {bidBoardStageLabel(deal)}
              </span>
            ) : (
              <DealStageBadge stageId={deal.stageId} />
            )}
            <span className="text-lg font-semibold">
              {formatCurrency(bestEstimate(deal))}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Stage Advancement Dropdown */}
          {!currentStage?.isTerminal && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button>
                  Move Stage
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>}
              />
              <DropdownMenuContent align="end">
                {manualForwardStages.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => handleStageChange(s.id)}
                  >
                    {s.name}
                    {s.isTerminal && (
                      <Badge variant="outline" className="ml-2 text-xs">
                        Terminal
                      </Badge>
                    )}
                  </DropdownMenuItem>
                ))}
                {readonlyForwardStages.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    disabled
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span>{s.name}</span>
                      <Badge variant="outline" className="text-xs">
                        Bid Board managed
                      </Badge>
                    </div>
                  </DropdownMenuItem>
                ))}
                {isDirectorOrAdmin && backwardStages.length > 0 && (
                  <>
                    <div className="px-2 py-1.5 text-xs text-muted-foreground border-t mt-1 pt-1">
                      Move Backward (Director)
                    </div>
                    {backwardStages.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onClick={() => handleStageChange(s.id)}
                        className="text-orange-600"
                      >
                        {s.name}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Reopen button for terminal stages (directors only) */}
          {currentStage?.isTerminal && isDirectorOrAdmin && !isBidBoardOwned && (
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

          {/* Create Task */}
          <TaskCreateDialog defaultDealId={deal.id} onCreated={refetch} />

          {/* More Actions */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>}
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/deals/${deal.id}/edit`)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit Deal
              </DropdownMenuItem>
              {isDirectorOrAdmin && (
                <DropdownMenuItem
                  onClick={handleDelete}
                  className="text-red-600"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Deal
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Active Timers Banner */}
      <DealTimersBanner dealId={deal.id} />

      {isBidBoardOwned && bidBoardOwnership && (
        <BidBoardOwnershipBanner
          ownership={bidBoardOwnership}
          readOnlySyncedAt={deal.readOnlySyncedAt}
          onRefresh={refetch}
        />
      )}

      <RfpApprovalStatusBlock deal={deal} onRetry={handleRfpRetry} retrying={rfpRetrying} />

      {isBidBoardOwned && !deal.hubspotDealId && <BidBoardProjectSummaryPanel deal={deal} />}

      {/* Estimating Sub-Stage Indicator */}
      {isEstimatingBoundaryStageSlug(currentStageSlug, workflowRoute) && !isBidBoardOwned && (
        <DealEstimatingSubstage deal={deal} onUpdate={refetch} />
      )}

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-brand-red text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => handleTabSelect(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          {isEstimatingBoundaryStageSlug(currentStageSlug, workflowRoute) && !isBidBoardOwned && (
            <DealProposalCard
              deal={deal}
              onUpdate={refetch}
              onOpenProposalEditor={handleOpenProposalEditor}
            />
          )}
          {!isBidBoardOwned && (
            <DealContractSignedCard
              deal={deal}
              canEdit={isDirectorOrAdmin}
              onUpdate={refetch}
            />
          )}
          {isBidBoardOwned && bidBoardOwnership && (
            <BidBoardReadOnlySummary ownership={bidBoardOwnership} />
          )}
          <DealOverviewTab deal={deal} onDealUpdated={refetch} />
        </div>
      )}
      {activeTab === "lead" && (
        <DealLeadTab
          deal={deal}
          isConverted={Boolean(deal.sourceLeadId)}
        />
      )}
      {activeTab === "scoping" &&
        (isBidBoardOwned && bidBoardOwnership ? (
          <DealScopingReadOnlyPanel
            ownership={bidBoardOwnership}
            onOpenTab={handleTabSelect}
          />
        ) : (
          <DealScopingWorkspace deal={deal} onDealUpdated={refetch} />
        ))}
      {activeTab === "files" && <DealFileTab dealId={deal.id} />}
      {activeTab === "photos" && <DealPhotosTab dealId={deal.id} onCountChange={setPhotoCount} />}
      {activeTab === "email" && <DealEmailTab dealId={deal.id} />}
      {activeTab === "activity" && <DealActivityPanel dealId={deal.id} />}
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
      {activeTab === "estimates" && (
        <DealEstimatesTab
          dealId={deal.id}
          proposalMode={searchParams.get("mode") === "proposal"}
        />
      )}
      {activeTab === "punch_list" && <DealPunchListTab dealId={deal.id} />}
      {activeTab === "closeout" && <DealCloseoutTab dealId={deal.id} />}

      {/* Stage Change Dialog */}
      {stageChangeOpen && targetStageId && (
        <StageChangeDialog
          deal={deal}
          targetStageId={targetStageId}
          open={stageChangeOpen}
          onOpenChange={(open) => {
            setStageChangeOpen(open);
            if (!open) setTargetStageId(null);
          }}
          onSuccess={handleStageChangeSuccess}
        />
      )}
    </div>
  );
}

function RfpApprovalStatusBlock({
  deal,
  onRetry,
  retrying,
}: {
  deal: DealDetail;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (!deal.rfpApprovalStatus) return null;

  const conflictSummary =
    deal.rfpConflictWith && typeof deal.rfpConflictWith === "object"
      ? Object.entries(deal.rfpConflictWith)
          .slice(0, 3)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join(", ")
      : null;

  const state = {
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
  }[deal.rfpApprovalStatus];

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
        </div>
        {deal.rfpApprovalStatus === "send_failed" && (
          <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying..." : "Retry"}
          </Button>
        )}
      </div>
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

function DealActivityPanel({ dealId }: { dealId: string }) {
  const { activities, loading, refetch } = useActivities({ dealId });

  const handleLogActivity = async (data: {
    type: string;
    subject: string;
    body: string;
    outcome?: string;
    durationMinutes?: number;
  }) => {
    await createActivity({
      type: data.type,
      subject: data.subject,
      body: data.body,
      outcome: data.outcome,
      durationMinutes: data.durationMinutes,
      dealId,
    });
    refetch();
  };

  return (
    <div className="space-y-4">
      <RecordingList entityType="deal" entityId={dealId} />
      <ActivityLogForm onSubmit={handleLogActivity} />
      {loading ? (
        <div className="h-32 bg-muted animate-pulse rounded" />
      ) : activities.length === 0 ? (
        <p className="text-center py-8 text-muted-foreground text-sm">
          No activities logged for this deal yet.
        </p>
      ) : (
        <div className="space-y-2">
          {activities.map((a) => (
            <div key={a.id} className="flex items-start gap-3 px-3 py-2.5 rounded-md border">
              <div className="flex-1">
                <span className="text-sm font-medium capitalize">{a.type}</span>
                {a.body && <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{a.body}</p>}
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(a.occurredAt).toLocaleDateString("en-US", {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
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
