import { useState, useCallback, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Edit,
  Trash2,
  ChevronRight,
  MoreHorizontal,
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
import { DealOverviewTab } from "@/components/deals/deal-overview-tab";
import { DealHistoryTab } from "@/components/deals/deal-history-tab";
import { DealTimelineTab } from "@/components/deals/deal-timeline-tab";
import { DealScopingWorkspace } from "@/components/deals/deal-scoping-workspace";
import { DealFileTab } from "@/components/files/deal-file-tab";
import { DealTeamTab } from "./deal-team-tab";
import { DealEstimatesTab } from "./deal-estimates-tab";
import { DealPunchListTab } from "./deal-punch-list-tab";
import { DealCloseoutTab } from "./deal-closeout-tab";
import { DealTimersBanner } from "./deal-timers-banner";
import { DealProposalCard } from "./deal-proposal-card";
import { DealEstimatingSubstage } from "./deal-estimating-substage";
import { LeadForm } from "@/components/leads/lead-form";
import { LeadTimelineTab } from "@/components/leads/lead-timeline-tab";
import { ActivityLogForm } from "@/components/activities/activity-log-form";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";
import { useActivities, createActivity } from "@/hooks/use-activities";
import { useDealDetail, deleteDeal as apiDeleteDeal, type DealDetail } from "@/hooks/use-deals";
import { useCompanyDetail } from "@/hooks/use-companies";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { useAuth } from "@/lib/auth";
import { formatCurrency, bestEstimate } from "@/lib/deal-utils";

type Tab = "overview" | "lead" | "scoping" | "files" | "email" | "activity" | "timeline" | "history" | "team" | "estimates" | "punch_list" | "closeout";

export function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { deal, loading, error, refetch } = useDealDetail(id);
  const { company } = useCompanyDetail(deal?.companyId ?? undefined);
  const { stages } = usePipelineStages();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [targetStageId, setTargetStageId] = useState<string | null>(null);
  const [teamCount, setTeamCount] = useState<number | null>(null);

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

  const currentStage = stages.find((s) => s.id === deal.stageId);
  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";

  // Build stage advancement options
  const forwardStages = stages.filter(
    (s) => s.displayOrder > (currentStage?.displayOrder ?? 0)
  );
  const backwardStages = stages.filter(
    (s) => s.displayOrder < (currentStage?.displayOrder ?? 0) && !s.isTerminal
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

  const currentStageSlug = currentStage?.slug ?? "";
  const showPunchList = ["in_production", "close_out", "closed_won"].includes(currentStageSlug);
  const showCloseout = ["close_out", "closed_won"].includes(currentStageSlug);

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "lead", label: "Lead" },
    { key: "scoping", label: "Scoping" },
    { key: "files", label: "Files" },
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
  const requestedTab = searchParams.get("tab");
  const requestedFocus = searchParams.get("focus");

  useEffect(() => {
    const nextTab =
      requestedTab && availableTabs.includes(requestedTab as Tab)
        ? (requestedTab as Tab)
        : "overview";
    setActiveTab((current) => (current === nextTab ? current : nextTab));
  }, [availableTabs, requestedTab]);

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

  const handleTabSelect = (tab: Tab) => {
    setActiveTab(tab);
    const nextParams = new URLSearchParams(searchParams);
    if (tab === "overview") {
      nextParams.delete("tab");
    } else {
      nextParams.set("tab", tab);
      nextParams.delete("focus");
    }
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
          <div className="flex items-center gap-3 mt-1">
            <DealStageBadge stageId={deal.stageId} />
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
                {forwardStages.map((s) => (
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
          {currentStage?.isTerminal && isDirectorOrAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline">Reopen Deal</Button>}
              />
              <DropdownMenuContent align="end">
                {stages
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

      {/* Estimating Sub-Stage Indicator */}
      {currentStageSlug === "estimating" && (
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
          {(currentStageSlug === "estimating" || currentStageSlug === "bid_sent") && (
            <DealProposalCard deal={deal} onUpdate={refetch} />
          )}
          <DealOverviewTab deal={deal} />
        </div>
      )}
      {activeTab === "lead" && (
        <DealLeadTab
          deal={deal}
          companyName={company?.name ?? null}
          isConverted={currentStageSlug !== "dd"}
        />
      )}
      {activeTab === "scoping" && <DealScopingWorkspace deal={deal} onDealUpdated={refetch} />}
      {activeTab === "files" && <DealFileTab dealId={deal.id} />}
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
      {activeTab === "estimates" && <DealEstimatesTab dealId={deal.id} />}
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
  companyName,
  isConverted,
}: {
  deal: DealDetail;
  companyName: string | null;
  isConverted: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
      <LeadForm
        lead={{
          id: deal.id,
          name: deal.name,
          dealNumber: deal.dealNumber,
          companyId: deal.companyId,
          companyName,
          stageId: deal.stageId,
          propertyAddress: deal.propertyAddress,
          propertyCity: deal.propertyCity,
          propertyState: deal.propertyState,
          propertyZip: deal.propertyZip,
          source: deal.source,
          description: deal.description,
          stageEnteredAt: deal.stageEnteredAt,
        }}
        converted={isConverted}
      />

      <LeadTimelineTab
        dealId={deal.id}
        convertedAt={isConverted ? deal.stageEnteredAt : null}
      />
    </div>
  );
}
