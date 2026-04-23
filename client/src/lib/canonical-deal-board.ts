import type { Deal, DealBoardColumn } from "@/hooks/use-deals";
import {
  getDealBoardStageSlugs,
  getDealStageLabelBySlug,
  getDealStageMetadata,
  normalizeDealStageSlug,
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

export function buildCanonicalDealBoardColumns(
  rawColumns: DealBoardColumn[] | null | undefined,
  stages: DealStageLike[]
): DealBoardColumn[] {
  const deals = (rawColumns ?? []).flatMap((column) => column.cards);

  return getDealBoardStageSlugs().map((slug) => {
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
        (column) =>
          normalizeDealStageSlug(column.stage.slug, "normal") === slug ||
          normalizeDealStageSlug(column.stage.slug, "service") === slug
      )?.stage;

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
      count: cards.length,
      totalValue: cards.reduce((sum, deal) => sum + getDealValue(deal), 0),
      cards,
    };
  });
}

function getDealValue(deal: Deal) {
  const candidates = [deal.awardedAmount, deal.bidEstimate, deal.ddEstimate];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}
