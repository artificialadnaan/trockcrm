import type { Deal, DealBoardColumn } from "@/hooks/use-deals";
import { getEffectiveDealValue } from "@trock-crm/shared/types";
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
  stages: DealStageLike[]
): DealBoardColumn[] {
  const deals = dedupeDealsById((rawColumns ?? []).flatMap((column) => column.cards));

  return getDealBoardStageSlugs().map((slug) => {
    const matchingRawColumns = (rawColumns ?? []).filter((column) => {
      const rawSlug = column.stage.slug;
      const columnRoute = workflowRouteFromColumn(column as RawColumnRouteLike);
      return normalizeDealStageSlug(rawSlug, columnRoute) === slug;
    });
    const cards = deals.filter((deal) => {
      const workflowRoute = deal.workflowRoute ?? "normal";
      return getDealStageMetadata(
        {
          stageId: deal.stageId,
          workflowRoute,
          isBidBoardOwned: deal.isBidBoardOwned,
          bidBoardStageSlug: deal.bidBoardStageSlug,
          readOnlySyncedAt: deal.readOnlySyncedAt,
        },
        stages
      ).slug === slug;
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
}

function getDealValue(deal: Deal, canonicalStageSlug: string) {
  return getEffectiveDealValue({
    ...deal,
    stageSlug: deal.stageSlug ?? canonicalStageSlug,
  });
}
