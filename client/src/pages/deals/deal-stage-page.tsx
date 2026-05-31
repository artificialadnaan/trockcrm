import { Navigate, useParams } from "react-router-dom";
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
import { useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useAuth } from "@/lib/auth";

export function DealStagePage() {
  const { stageId } = useParams();
  const route = useNormalizedStageRoute("deals", stageId!);
  const { data, loading, error } = useDealStagePage({ stageId: stageId!, ...route.query });
  const { regions } = useRegions();
  const { projectTypes } = useProjectTypes();
  const { assignees } = useTaskAssignees();
  const { user } = useAuth();
  const summary = buildDealStageSummary(data);

  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  if (error) return <div className="text-sm text-rose-600">{error}</div>;
  if (loading || !data) return <div className="text-sm text-slate-500">Loading stage...</div>;

  const stage = data.stage;

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
        baseFilters={{ stageIds: [stage.id] }}
        filterBar={{
          dimensions: getDrilldownFilterBarDimensions({ pinnedStage: true, ownRep: user?.role === "admin" }),
          options: {
            reps: assignees.map((assignee) => ({ value: assignee.id, label: assignee.displayName })),
            regions: regions.map((region) => ({ value: region.id, label: region.name })),
            projectTypes: projectTypes.map((type) => ({ value: type.id, label: type.name })),
            sortOptions: DEAL_LIST_SORT_OPTIONS,
          },
          stageEntryDateEnabled: true,
          defaultStageIds: [stage.id],
          terminalStageIds: isTerminalStage(stage.slug) ? [stage.id] : [],
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
