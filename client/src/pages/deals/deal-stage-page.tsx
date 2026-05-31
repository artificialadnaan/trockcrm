import { Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useDealStagePage } from "@/hooks/use-deals";
import { formatCurrencyCompact } from "@/lib/deal-utils";
import { buildDealStageSummary } from "@/lib/pipeline-stage-summary";
import { useNormalizedStageRoute } from "@/lib/pipeline-scope";
import { PipelineStagePageHeader } from "@/components/pipeline/pipeline-stage-page-header";
import { DealsListSection } from "@/components/deals/deals-list-section";
import {
  DEAL_LIST_SORT_OPTIONS,
  DRILLDOWN_FILTERBAR_PARAM_PREFIX,
  getDrilldownFilterBarDimensions,
} from "@/components/deals/deals-filterbar-adapter";
import { isTerminalStage } from "@/lib/pipeline-terminal-filters";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useAuth } from "@/lib/auth";
import {
  getStagePageBarRedirectSearch,
  getStagePageListStageIds,
  isWonStagePageStage,
} from "@/lib/pipeline-stage-page";

export function DealStagePage() {
  const { stageId } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const route = useNormalizedStageRoute("deals", stageId!);
  const { data, loading, error } = useDealStagePage({ stageId: stageId!, ...route.query });
  const { regions } = useRegions();
  const { projectTypes } = useProjectTypes();
  const { assignees } = useTaskAssignees();
  const { stages, loading: stagesLoading } = usePipelineStages("deal");
  const { user } = useAuth();
  const summary = buildDealStageSummary(data);

  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  // The A′ bar OWNS the list's filter state: if the URL still carries inherited bare filter params
  // (from the dashboard nav / a legacy bookmark), translate them into the fb_ namespace and strip the
  // bare ones, so the bar SHOWS them and Clear actually clears them (Codex P2) — and the header summary
  // reads no filters = whole-stage (signed-off intent). One-time, terminates (the bare trigger is gone).
  const barRedirect = getStagePageBarRedirectSearch(searchParams, DRILLDOWN_FILTERBAR_PARAM_PREFIX);
  if (barRedirect !== null) {
    return <Navigate to={barRedirect ? `${location.pathname}?${barRedirect}` : location.pathname} replace />;
  }
  if (error) return <div className="text-sm text-rose-600">{error}</div>;
  // Wait while stages are LOADING (the terminal family broadening needs them). If they FAIL,
  // stagesLoading is false and getStagePageListStageIds falls back to the route stage id, so the list
  // stays scoped to the route stage instead of rendering unscoped (Codex P2) — never block on the error.
  if (loading || stagesLoading || !data) return <div className="text-sm text-slate-500">Loading stage...</div>;

  const stage = data.stage;
  // The list's stage scope = the SAME population the header counts: a Won/Lost stage broadens to its
  // terminal alias family (mirrors the server stage endpoint), every other stage stays its single id.
  const listStageIds = getStagePageListStageIds(stage, stages);
  // Won stages also exclude on-hold (migration parking-lot) deals — the Won summary does too, so the
  // list reconciles to the header count. Lost stages keep them (the summary doesn't exclude there).
  const excludeOnHold = isWonStagePageStage(stage.slug);

  return (
    <PipelineStagePageHeader
      backTo={route.backTo}
      title={stage.name}
      subtitle={`${summary.totalDealCount} total deal${summary.totalDealCount === 1 ? "" : "s"} in this stage · ${summary.totalCount} active`}
      summary={
        <>
          <SummaryMetric label="Active / total" value={`${summary.totalCount}/${summary.totalDealCount}`} />
          <SummaryMetric label="Stage value" value={formatCompactValue(summary.totalValue)} />
          <SummaryMetric
            label="Avg. visible age"
            value={`${data.summary.averageDaysInStage ?? summary.averageAgeDays} days`}
          />
        </>
      }
    >
      {/* Fork A′: the full outcome-aware FilterBar replaces the legacy Updated-After / Min-Age grid.
          The list routes through getDeals (every dimension + outcome-aware Date that windows open rows
          now the flag is on); useDealStagePage above stays ONLY for the whole-stage summary metrics. The
          route pins the stage (no stage dimension); the bespoke admin rep select folds into the bar (rep
          dim, admin-only as before); the fb_ namespace keeps the bar's params off the route's scope/page. */}
      <DealsListSection
        workflowFamily="deal"
        scope={route.query.scope}
        enableExport
        pageSize={20}
        searchPlaceholder="Deal, number, city, state"
        visibleStages={[stage]}
        baseFilters={{
          stageIds: listStageIds,
          ...(excludeOnHold ? { excludeOnHold: true } : {}),
        }}
        filterBar={{
          dimensions: getDrilldownFilterBarDimensions({ pinnedStage: true, ownRep: user?.role === "admin" }),
          options: {
            reps: assignees.map((assignee) => ({ value: assignee.id, label: assignee.displayName })),
            regions: regions.map((region) => ({ value: region.id, label: region.name })),
            projectTypes: projectTypes.map((type) => ({ value: type.id, label: type.name })),
            sortOptions: DEAL_LIST_SORT_OPTIONS,
          },
          stageEntryDateEnabled: true,
          defaultStageIds: listStageIds,
          terminalStageIds: isTerminalStage(stage.slug) ? listStageIds : [],
          paramPrefix: DRILLDOWN_FILTERBAR_PARAM_PREFIX,
          // Default the list to days-in-stage (oldest entry first) — the stage drill-down's age focus —
          // when the bar carries no explicit sort.
          defaultSort: { key: "stage_entered_at", dir: "asc" },
        }}
      />
    </PipelineStagePageHeader>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-black tracking-[0.18em] text-slate-500 uppercase">{label}</p>
      <p className="text-[2rem] leading-none font-black tracking-tight text-slate-950">{value}</p>
    </div>
  );
}

function formatCompactValue(value: number) {
  return formatCurrencyCompact(value).replace(".0", "");
}
