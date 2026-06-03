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
import { withResolvedDateWindow } from "@/components/filters/filterbar-date";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useAuth } from "@/lib/auth";
import {
  getStagePageBarRedirectSearch,
  getStagePageListStageIds,
  isWonStagePageStage,
  type StagePageFilters,
} from "@/lib/pipeline-stage-page";

/**
 * Build the filters for the whole-stage SUMMARY query (useDealStagePage → the header "Stage value").
 * Bug B: that total must reconcile with the rep/date-scoped board card. The A′ mount strips the
 * inherited bare rep/date (the bar OWNS the list's filter state), so the summary would otherwise run
 * whole-stage and disagree with the board. Re-read the active rep + date — the bar's fb_ namespace
 * first, then the inherited bare params (so the summary is correct on the pre-redirect first paint too)
 * — and apply them. The date is written to BOTH the Won and Lost windows; the server (listDealStagePage)
 * applies only the one matching the route stage's outcome, so this stays outcome-agnostic here.
 *
 * `ownRep` mirrors the list's Rep dimension (admin-only). When the bar does NOT render Rep, the list
 * ignores an inherited fb_assignedRepId, so the summary must ignore it too — otherwise the header would
 * be rep-scoped while the visible list (scoped only by mine/all) is all-rep (Codex P2).
 *
 * No explicit window ⇒ all-time: the board treats "no period" as all-time and the list shows all-time
 * with no date, so pin wonAllTime/lostAllTime rather than let the server fall back to its 30-day terminal
 * default — otherwise an all-time board card would open a 30-day header total (Codex P2).
 */
export function buildStageSummaryFilters(
  searchParams: URLSearchParams,
  baseFilters: StagePageFilters,
  options: { ownRep: boolean },
  prefix = DRILLDOWN_FILTERBAR_PARAM_PREFIX
): StagePageFilters {
  const fb = (key: string) => searchParams.get(`${prefix}${key}`) || undefined;
  const assignedRepId = options.ownRep
    ? fb("assignedRepId") ?? (searchParams.get("assignedRepId") || undefined)
    : undefined;
  // Resolve the bar's date the SAME way the list does (withResolvedDateWindow): a relative preset such
  // as fb_datePreset=30/ytd re-derives a fresh window for now, so a bookmark's stale fb_dateFrom/dateTo
  // can't make the header diverge from the list on a later day (Codex P2). Falls back to the inherited
  // bare won/lost bounds for the pre-redirect first paint.
  const barDate = withResolvedDateWindow({
    datePreset: fb("datePreset"),
    dateFrom: fb("dateFrom"),
    dateTo: fb("dateTo"),
  });
  const from = barDate.dateFrom ?? (searchParams.get("won_since") || searchParams.get("lost_since") || undefined);
  const to = barDate.dateTo ?? (searchParams.get("won_until") || searchParams.get("lost_until") || undefined);
  const allTime = !from && !to;
  // The remaining list filters all narrow the deal set, so the top "Stage Value" must apply them too —
  // read them from the bar's fb_ namespace exactly like rep+date, so the header recomputes with the same
  // set the list shows. (status, workflow, type, value range, stalled/days-in-stage.)
  const status = fb("status");
  const workflowRoute = fb("workflowRoute");
  const regionId = fb("regionId");
  const projectTypeId = fb("projectTypeId");
  const valueMin = fb("valueMin");
  const valueMax = fb("valueMax");
  const minAgeDays = fb("minAgeDays");
  const maxAgeDays = fb("maxAgeDays");
  return {
    ...baseFilters,
    ...(assignedRepId ? { assignedRepId } : {}),
    ...(status ? { status } : {}),
    ...(workflowRoute ? { workflowRoute } : {}),
    ...(regionId ? { regionId } : {}),
    ...(projectTypeId ? { projectTypeId } : {}),
    ...(valueMin ? { valueMin } : {}),
    ...(valueMax ? { valueMax } : {}),
    ...(minAgeDays ? { minAgeDays } : {}),
    ...(maxAgeDays ? { maxAgeDays } : {}),
    ...(from ? { wonSince: from, lostSince: from } : {}),
    ...(to ? { wonUntil: to, lostUntil: to } : {}),
    ...(allTime ? { wonAllTime: true, lostAllTime: true } : {}),
  };
}

/**
 * Bug B: when the dashboard nav arrives with an inherited Won/Lost window (won_since/won_until or
 * lost_since/lost_until), carry it into the bar's fb_ date namespace during the mount redirect, so the
 * bar shows it, the list scopes by it, and the header summary reconciles with the list and the board
 * card. A date the user already set on the bar (fb_dateFrom/fb_dateTo) wins (no clobber).
 */
export function appendInheritedTerminalDateToBarSearch(
  barSearch: string,
  original: URLSearchParams,
  prefix = DRILLDOWN_FILTERBAR_PARAM_PREFIX
): string {
  const params = new URLSearchParams(barSearch);
  const from = original.get("won_since") || original.get("lost_since") || undefined;
  const to = original.get("won_until") || original.get("lost_until") || undefined;
  if (from && !params.has(`${prefix}dateFrom`)) params.set(`${prefix}dateFrom`, from);
  if (to && !params.has(`${prefix}dateTo`)) params.set(`${prefix}dateTo`, to);
  return params.toString();
}

export function DealStagePage() {
  const { stageId } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const route = useNormalizedStageRoute("deals", stageId!);
  const { user } = useAuth();
  // Bug B: the header summary inherits the bar's active rep + date so the "Stage value" total reconciles
  // with the rep/date-scoped board card — it is no longer forced whole-stage. The server already scopes
  // /deals/stages/:id by assignedRepId + the Won/Lost window when they are sent. `ownRep` matches the
  // bar's Rep dimension (admin-only) so the summary only rep-scopes when the list does.
  const summaryFilters = buildStageSummaryFilters(searchParams, route.query.filters, {
    ownRep: user?.role === "admin",
  });
  // Search also narrows the list, so feed the bar's fb_search into the summary too (route.query.search is
  // the stripped bare param). Falls back to the normalized bare search for the pre-redirect first paint.
  const summarySearch =
    searchParams.get(`${DRILLDOWN_FILTERBAR_PARAM_PREFIX}search`) || route.query.search;
  const { data, loading, error } = useDealStagePage({
    stageId: stageId!,
    ...route.query,
    search: summarySearch,
    filters: summaryFilters,
  });
  const { regions } = useRegions();
  const { projectTypes } = useProjectTypes();
  const { assignees } = useTaskAssignees();
  const { stages, loading: stagesLoading } = usePipelineStages("deal");
  const summary = buildDealStageSummary(data);

  if (route.needsRedirect) return <Navigate to={route.redirectTo} replace />;
  // The A′ bar OWNS the list's filter state: if the URL still carries inherited bare filter params
  // (from the dashboard nav / a legacy bookmark), translate them into the fb_ namespace and strip the
  // bare ones, so the bar SHOWS them and Clear actually clears them (Codex P2). The inherited Won/Lost
  // window is carried into the bar's fb_ date too, so the bar, the list, AND the header summary all
  // reflect the same active rep + date and reconcile with the board card (Bug B). One-time, terminates.
  const barRedirect = getStagePageBarRedirectSearch(searchParams, DRILLDOWN_FILTERBAR_PARAM_PREFIX);
  if (barRedirect !== null) {
    const withDate = appendInheritedTerminalDateToBarSearch(barRedirect, searchParams);
    return <Navigate to={withDate ? `${location.pathname}?${withDate}` : location.pathname} replace />;
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
