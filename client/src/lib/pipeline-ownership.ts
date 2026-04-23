import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CRM_OWNED_LEAD_STAGE_LABELS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
} from "./sales-workflow";

const LEGACY_BID_BOARD_MIRRORED_STAGE_SLUGS = [
  "estimating",
  "bid_sent",
  "in_production",
  "close_out",
  "closed_won",
  "closed_lost",
] as const;

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

export function isEstimatingBoundaryStageSlug(
  stageSlug: string,
  workflowRoute: "normal" | "service"
) {
  return (
    stageSlug === "estimating" ||
    stageSlug === (workflowRoute === "service" ? "service_estimating" : "estimate_in_progress")
  );
}

export function isBidBoardMirroredStageSlug(stageSlug: string | null | undefined) {
  if (!stageSlug) return false;

  return (
    BID_BOARD_MIRRORED_STAGE_SLUGS.includes(
      stageSlug as (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number]
    ) ||
    LEGACY_BID_BOARD_MIRRORED_STAGE_SLUGS.includes(
      stageSlug as (typeof LEGACY_BID_BOARD_MIRRORED_STAGE_SLUGS)[number]
    )
  );
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
  const isMirroredStage = isBidBoardMirroredStageSlug(slug);
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

  if (isBidBoardMirroredStageSlug(stage.slug)) {
    return {
      label: "Bid Board mirror",
      secondaryLabel: "Read-only in CRM",
      tone: "mirror" as const,
    };
  }

  return null;
}
