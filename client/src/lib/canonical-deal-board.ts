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
        ? matchingRawColumns.reduce((sum, column) => sum + column.count, 0)
        : cards.length,
      totalValue: hasBackendAggregate
        ? matchingRawColumns.reduce((sum, column) => sum + column.totalValue, 0)
        : cards.reduce((sum, deal) => sum + getDealValue(deal, slug), 0),
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
