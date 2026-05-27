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

export function buildCanonicalDealBoardColumns(
  rawColumns: DealBoardColumn[] | null | undefined,
  stages: DealStageLike[]
): DealBoardColumn[] {
  const deals = (rawColumns ?? []).flatMap((column) => column.cards);

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
