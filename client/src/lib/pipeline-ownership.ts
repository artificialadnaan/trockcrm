import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CRM_OWNED_LEAD_STAGE_LABELS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
} from "./sales-workflow";

export type LeadBoardStageSlug = Exclude<(typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number], "opportunity">;

export const LEAD_BOARD_STAGE_SLUGS: LeadBoardStageSlug[] = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
];

export function getLeadBoardStageLabel(slug: LeadBoardStageSlug) {
  return CRM_OWNED_LEAD_STAGE_LABELS[slug];
}

export function getLeadStageMetadata(
  stageId: string,
  stages: Array<{ id: string; name: string; slug: string }>
) {
  const stage = stages.find((entry) => entry.id === stageId) ?? null;
  const slug = stage?.slug ?? null;
  const isCrmOwnedLeadStage =
    slug != null &&
    CRM_OWNED_LEAD_STAGE_SLUGS.includes(slug as (typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number]);
  const isBoardStage = slug != null && LEAD_BOARD_STAGE_SLUGS.includes(slug as LeadBoardStageSlug);

  return {
    stage,
    slug,
    label:
      slug && slug in CRM_OWNED_LEAD_STAGE_LABELS
        ? CRM_OWNED_LEAD_STAGE_LABELS[slug as keyof typeof CRM_OWNED_LEAD_STAGE_LABELS]
        : stage?.name ?? "Lead",
    isCrmOwnedLeadStage,
    isBoardStage,
    isOpportunityStage: slug === "opportunity",
  };
}

export function getWorkflowRouteLabel(route: "normal" | "service") {
  return route === "service" ? "Service" : "Normal";
}

export function getDealStageMetadata(
  deal: {
    stageId: string;
    workflowRoute: "normal" | "service";
    isBidBoardOwned: boolean;
    bidBoardStageSlug: string | null;
    readOnlySyncedAt: string | null;
  },
  stages: Array<{ id: string; name: string; slug: string }>
) {
  const stage = stages.find((entry) => entry.id === deal.stageId) ?? null;
  const slug = deal.bidBoardStageSlug ?? stage?.slug ?? null;
  const isMirroredStage =
    slug != null &&
    BID_BOARD_MIRRORED_STAGE_SLUGS.includes(slug as (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number]);
  const isOpportunityStage = slug === "opportunity";
  const isReadOnlyInCrm = isMirroredStage || Boolean(deal.isBidBoardOwned || deal.readOnlySyncedAt);

  return {
    stage,
    slug,
    label: stage?.name ?? "Deal",
    isOpportunityStage,
    isMirroredStage,
    isReadOnlyInCrm,
    sourceOfTruth: isReadOnlyInCrm ? ("bid_board" as const) : ("crm" as const),
    routeLabel: getWorkflowRouteLabel(deal.workflowRoute),
  };
}

export function getDealColumnOwnership(stage: { slug: string }) {
  if (stage.slug === "opportunity") {
    return {
      label: "CRM editable",
      tone: "crm" as const,
    };
  }

  if (
    BID_BOARD_MIRRORED_STAGE_SLUGS.includes(
      stage.slug as (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number]
    )
  ) {
    return {
      label: "Bid Board mirror",
      secondaryLabel: "Read-only in CRM",
      tone: "mirror" as const,
    };
  }

  return null;
}
