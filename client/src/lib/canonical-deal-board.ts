import type { Deal, DealBoardColumn, DealBoardSummary } from "@/hooks/use-deals";
import { getEffectiveDealValue, isPendingRfpBoardCard } from "@trock-crm/shared/types";
import {
  getDealBoardStageSlugs,
  getDealStageLabelBySlug,
  getDealStageMetadata,
  normalizeDealStageSlug,
  workflowRouteFromStage,
} from "@/lib/pipeline-ownership";

type DealStageLike = {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  displayOrder?: number | null;
  isActivePipeline?: boolean | null;
  isTerminal?: boolean | null;
  workflowFamily?: string | null;
};

type RawColumnRouteLike = DealBoardColumn & {
  workflowRoute?: "normal" | "service" | null;
  stage: DealBoardColumn["stage"] & DealStageLike;
};

function workflowRouteFromColumn(column: RawColumnRouteLike): "normal" | "service" {
  if (column.workflowRoute === "service") return "service";
  if (column.workflowRoute === "normal") return "normal";

  const firstCardRoute = column.cards.find((deal) => deal.workflowRoute != null)?.workflowRoute;
  if (firstCardRoute === "service") return "service";
  if (firstCardRoute === "normal") return "normal";

  return workflowRouteFromStage(column.stage);
}

// The server's getDealsForPipeline emits one pipelineColumns row per Won-family
// stage (won, closed_won, sent_to_production, etc.), and each row carries the
// SAME canonical aggregate computed via inArray(deals.stageId, wonStageIds).
// The Lost-family stages (lost, closed_lost, production_lost, service_lost)
// share the symmetric pattern. If the client sums every matching raw column for
// these canonical slugs, the Won/Lost totals get multiplied by however many
// Won/Lost-family rows the server emits (triple- or quadruple-counted in
// production). For these slugs we must pick a single canonical raw column
// instead of summing across them. Other canonical slugs (e.g. estimating) do
// not have the same duplicate-aggregate emission, so summing is still correct.
function shouldPickSingleAggregate(canonicalSlug: string): boolean {
  return canonicalSlug === "won" || canonicalSlug === "lost";
}

function selectCanonicalRawColumn<T extends { stage: DealStageLike }>(
  matchingRawColumns: T[],
  canonicalSlug: string
): T {
  // Priority 1: exact-canonical slug match (e.g. the row whose stage slug is
  // literally "won" or "lost") — this is the canonical row by definition.
  const exact = matchingRawColumns.find((column) => column.stage.slug === canonicalSlug);
  if (exact) return exact;
  // Priority 2: any matching row marked isActivePipeline === true — the
  // currently-live representation of the family.
  const active = matchingRawColumns.find((column) => column.stage.isActivePipeline === true);
  if (active) return active;
  // Priority 3: first matching row as a last resort.
  return matchingRawColumns[0]!;
}

// A single deal record can ride along in more than one raw column's `cards`: the
// server emits one pipelineColumns row per Won-/Lost-family stage and repeats the
// same canonical deal set in each. Flattening across raw columns therefore yields
// the same deal id multiple times, and because each copy resolves to the same
// current-stage slug it lands in its canonical column more than once — React then
// renders duplicate <Card key={deal.id}>. Dedupe by id (first occurrence wins) so
// every deal renders exactly once, in its single current-stage column. Header
// counts/totals are computed from the raw-column aggregates, not from `cards`, so
// this does not affect any column's count or value (incl. the Won basis).
function dedupeDealsById<T extends { id: string }>(deals: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const deal of deals) {
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    result.push(deal);
  }
  return result;
}

/**
 * Group raw stage ids into the canonical board columns they belong to (Codex #589 P1). Mirrors
 * buildCanonicalDealBoardColumns' membership EXACTLY: a stage joins the canonical column its slug
 * normalizes to under EITHER workflow route (the `|| service` OR above), so cross-slug aliases that
 * the board collapses into one column share one family — contract_signed + service_contract_signed →
 * "contract"; every Won/Lost alias → its terminal column. The stage OPTIONS the FilterBar shows carry
 * only ONE canonical id per column, so the list expands an explicit pick to its full family before
 * querying — otherwise getDeals' exact `stage_id IN (...)` would under-show the sibling-family deals the
 * board column represents. Returns one id-array per canonical slug (a stage that normalizes to two
 * canonical slugs — only the route-dependent estimating pair — appears in both, so a pick never
 * under-shows).
 */
export interface CanonicalDealStageFamily {
  /** The board's canonical column slug (won/lost/contract/estimating/…). */
  slug: string;
  /** Every raw stage id that normalizes to this canonical column (canonical + aliases). */
  ids: string[];
}

/**
 * Group raw stage ids into the canonical board columns they belong to, keyed by canonical slug. Used to
 * derive the under-kanban list's stage scope so it matches the board EXACTLY (Codex #589): the explicit-
 * pick family, the default-stage union, AND the terminal classification all flow from the SAME canonical
 * membership the board uses. ROUTE-SPECIFIC: each stage maps to ITS OWN route's column (workflowFamily →
 * route, with a service_-prefix slug fallback), so the route-dependent estimating pair never cross-
 * pollinates — a standard `estimating` stage joins ONLY the normal Estimating column, a service one ONLY
 * service_estimating (Codex #589 over-grouping P2; normalizing under BOTH routes over-showed the sibling
 * column). Route-INVARIANT aliases still land together (contract_signed/service_contract_signed → contract;
 * every Won/Lost alias → its terminal column; estimate_under_review/service_… → estimate_under_review).
 */
export function buildCanonicalDealStageFamilies(
  stages: Array<Pick<DealStageLike, "id" | "slug" | "workflowFamily">>
): CanonicalDealStageFamily[] {
  const byCanonical = new Map<string, string[]>();
  for (const stage of stages) {
    const slug = normalizeDealStageSlug(stage.slug, workflowRouteFromStage(stage));
    if (!slug) continue;
    const ids = byCanonical.get(slug) ?? [];
    if (!ids.includes(stage.id)) ids.push(stage.id);
    byCanonical.set(slug, ids);
  }
  return [...byCanonical.entries()].map(([slug, ids]) => ({ slug, ids }));
}

/**
 * The explicit-pick expansion families (one id-array per canonical column). Thin wrapper over
 * buildCanonicalDealStageFamilies; see it for the membership rule (Codex #589 P1).
 */
export function buildCanonicalDealStageIdFamilies(
  stages: Array<Pick<DealStageLike, "id" | "slug">>
): string[][] {
  return buildCanonicalDealStageFamilies(stages).map((family) => family.ids);
}

export function buildCanonicalDealBoardColumns(
  rawColumns: DealBoardColumn[] | null | undefined,
  stages: DealStageLike[],
  /**
   * Server-side board aggregates. When present, the Pending RFP column's count/$ (and therefore the
   * matching subtraction from Opportunity) come from a count over EVERY matching row instead of the
   * cards this response happened to carry — which is what lets the board request a small card slice
   * without the column silently under-reporting.
   */
  boardSummary?: DealBoardSummary | null,
  /**
   * The Pending RFP column's OWN preview cards, fetched server-side. The client used to filter them out
   * of the flattened Opportunity slice, which lost every pending deal ranked below the per-column cap —
   * a column whose header count said 42 rendering 2 cards. Falls back to the carve-out when absent.
   */
  pendingRfpCards?: Deal[] | null
): DealBoardColumn[] {
  const deals = dedupeDealsById((rawColumns ?? []).flatMap((column) => column.cards));

  const dealCanonicalSlug = (deal: Deal) =>
    getDealStageMetadata(
      {
        stageId: deal.stageId,
        workflowRoute: deal.workflowRoute ?? "normal",
        isBidBoardOwned: deal.isBidBoardOwned,
        bidBoardStageSlug: deal.bidBoardStageSlug,
        readOnlySyncedAt: deal.readOnlySyncedAt,
      },
      stages,
    ).slug;
  // The SHARED board predicate — the same one the server folds its Pending RFP count/$ aggregate with,
  // so the column's membership and the number on it cannot drift apart.
  const isPendingRfpCard = (deal: Deal) => isPendingRfpBoardCard(deal, dealCanonicalSlug(deal));
  // DELIBERATELY owner-scoped: the synthetic Pending RFP column is derived from THIS board's own cards
  // (already scope-filtered, value-resolved, and at-risk-decorated by the server pipeline), NOT a separate
  // office-wide cross-rep query. A cross-rep version was built and then reverted (PR #834) because an
  // all-office overlay cannot reconcile with the scope-filtered board: the synthetic `pending_rfp` column
  // is in the Active-Pipeline + At-Risk rollups, so its count can match the in-scope KPI OR its all-office
  // visible cards, not both; and a lean cross-rep projection loses value fields (expectedCloseDate
  // far-future zeroing, bidBoardTotalSales) + at-risk decoration. The complete cross-rep shared queue is
  // the dedicated /deals/pending-rfp dashboard. (The board passes BOARD_CARDS_PER_STAGE_LIMIT=1000, so
  // `deals` is the full Opportunity set in practice — no preview-truncation undercount.)
  const carvedPendingRfpCards = deals.filter(isPendingRfpCard);

  const columns: DealBoardColumn[] = getDealBoardStageSlugs().map((slug) => {
    const matchingRawColumns = (rawColumns ?? []).filter((column) => {
      const rawSlug = column.stage.slug;
      const columnRoute = workflowRouteFromColumn(column as RawColumnRouteLike);
      return normalizeDealStageSlug(rawSlug, columnRoute) === slug;
    });
    const cards = deals.filter((deal) => {
      if (dealCanonicalSlug(deal) !== slug) return false;
      if (slug === "opportunity" && isPendingRfpCard(deal)) return false;
      return true;
    });

    const matchingStage =
      stages.find((stage) => stage.slug === slug && stage.workflowFamily === "service_deal") ??
      stages.find((stage) => stage.slug === slug && stage.workflowFamily === "standard_deal") ??
      stages.find(
        (stage) =>
          normalizeDealStageSlug(stage.slug, "normal") === slug ||
          normalizeDealStageSlug(stage.slug, "service") === slug
      ) ??
      rawColumns?.find(
        (column) => {
          const columnRoute = workflowRouteFromColumn(column as RawColumnRouteLike);
          return normalizeDealStageSlug(column.stage.slug, columnRoute) === slug;
        }
      )?.stage;
    const hasBackendAggregate = matchingRawColumns.length > 0;
    const aggregateColumn =
      shouldPickSingleAggregate(slug) && matchingRawColumns.length > 1
        ? selectCanonicalRawColumn(matchingRawColumns as RawColumnRouteLike[], slug)
        : null;
    // Carry the API's REAL row total through. This used to be dropped, so every canonical column fell
    // back to `count` — the ACTIVE figure — while `cards` includes on-hold rows. That is what let a
    // truncated column report fewer "total" rows than it had cards and hide its own "view all".
    const rawTotalCount = hasBackendAggregate
      ? aggregateColumn !== null
        ? aggregateColumn.totalCount ?? aggregateColumn.count
        : matchingRawColumns.reduce((sum, column) => sum + (column.totalCount ?? column.count), 0)
      : cards.length;

    return {
      stage: {
        id: matchingStage?.id ?? `canonical-${slug}`,
        name: getDealStageLabelBySlug(slug),
        slug,
        color: matchingStage?.color ?? null,
        displayOrder: matchingStage?.displayOrder ?? 0,
        isActivePipeline: matchingStage?.isActivePipeline ?? true,
        isTerminal: matchingStage?.isTerminal ?? false,
      },
      count: hasBackendAggregate
        ? aggregateColumn !== null
          ? aggregateColumn.count
          : matchingRawColumns.reduce((sum, column) => sum + column.count, 0)
        : cards.length,
      totalCount: rawTotalCount,
      // What a stage drill-down opened from this column will list. Identical to `totalCount` everywhere
      // except Opportunity, whose totals get the Pending RFP bucket subtracted below while the stage
      // page it opens does not filter that bucket out.
      drilldownTotalCount: rawTotalCount,
      totalValue: hasBackendAggregate
        ? aggregateColumn !== null
          ? aggregateColumn.totalValue
          : matchingRawColumns.reduce((sum, column) => sum + column.totalValue, 0)
        : cards
            .filter((deal) => !deal.onHold)
            .reduce((sum, deal) => sum + getDealValue(deal, slug), 0),
      cards,
    };
  });

  // Board `count`/`totalValue` are the active/reportable figures (on-hold cards are excluded), so the
  // moved-card adjustment + the synthetic column must count active cards only — otherwise an on-hold
  // pending RFP would be double-counted out of opportunity and shown as active here.
  //
  // PREFER THE SERVER AGGREGATE. Counting `pendingRfpCards` here only ever saw the cards this response
  // carried, so with a capped per-column card slice both the Pending RFP column AND the Opportunity
  // column it is subtracted from would under-report. The server counts the same predicate over every
  // matching row. The card-derived numbers remain the fallback for a response without a summary.
  // The column's CARDS: the server's dedicated preview when present, else the historical carve-out.
  const pendingRfpColumnCards = pendingRfpCards ?? carvedPendingRfpCards;
  const activePendingRfp = carvedPendingRfpCards.filter((d) => !d.onHold);
  const pendingRfpCount = boardSummary?.pendingRfp.count ?? activePendingRfp.length;
  const pendingRfpTotalCount = boardSummary?.pendingRfp.totalCount ?? carvedPendingRfpCards.length;
  const pendingRfpValue =
    boardSummary?.pendingRfp.totalValue ??
    activePendingRfp.reduce((sum, d) => sum + getDealValue(d, "opportunity"), 0);

  const oppIndex = columns.findIndex((column) => column.stage.slug === "opportunity");
  // Always insert the synthetic Pending RFP column after Opportunity — even with zero pending cards — so the
  // stage stays visible on the board instead of vanishing when the queue drains to empty. An empty column is
  // count 0 / value 0 / cards [] and the opportunity adjustment below subtracts 0, so no rollup is disturbed.
  if (oppIndex !== -1) {
    const opp = columns[oppIndex]!;
    // Subtract the moved pending-RFP cards from the opportunity column's backend aggregate so
    // the two columns don't double-count (opportunity header would over-report otherwise).
    columns[oppIndex] = {
      ...opp,
      count: Math.max(0, opp.count - pendingRfpCount),
      // `totalCount` is partitioned too, so it still describes the cards THIS column renders (which
      // exclude the pending bucket) — that is the denominator the truncation notice needs.
      totalCount: Math.max(0, (opp.totalCount ?? opp.count) - pendingRfpTotalCount),
      // `drilldownTotalCount` is deliberately NOT reduced: "view all" opens the Opportunity stage page,
      // which filters by stage id and therefore still lists the pending-RFP deals. Advertising the
      // partitioned number there would send a user to a page holding more rows than the link promised.
      totalValue: opp.totalValue - pendingRfpValue,
    };
    columns.splice(oppIndex + 1, 0, {
      stage: {
        id: "canonical-pending_rfp",
        name: "Pending RFP",
        slug: "pending_rfp",
        color: null,
        displayOrder: (opp.stage.displayOrder ?? 0) + 1,
        isActivePipeline: false,
        isTerminal: false,
      },
      count: pendingRfpCount,
      totalCount: pendingRfpTotalCount,
      // No drill-down count: this column's "view all" opens /deals/pending-rfp, which is the office-wide
      // CROSS-REP queue by design (PR #834), while this column is scope-filtered. The board cannot know
      // that queue's size, so it must not put a number on the link.
      drilldownTotalCount: undefined,
      totalValue: pendingRfpValue,
      cards: pendingRfpColumnCards,
    });
  }
  return columns;
}

function getDealValue(deal: Deal, canonicalStageSlug: string) {
  return getEffectiveDealValue({
    ...deal,
    stageSlug: deal.stageSlug ?? canonicalStageSlug,
  });
}
