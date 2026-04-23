import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CRM_OWNED_LEAD_STAGE_LABELS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
} from "./sales-workflow";

export const LEGACY_LEAD_BOARD_STAGE_SLUGS = [
  "lead_new",
  "company_pre_qualified",
  "scoping_in_progress",
  "pre_qual_value_assigned",
  "lead_go_no_go",
  "qualified_for_opportunity",
] as const;
const LEGACY_MIRRORED_DEAL_STAGE_SLUGS = [
  "estimating",
  "bid_sent",
  "in_production",
  "close_out",
  "closed_won",
  "closed_lost",
] as const;

export type LeadBoardStageSlug = Exclude<(typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number], "opportunity">;
export type LegacyLeadBoardStageSlug = (typeof LEGACY_LEAD_BOARD_STAGE_SLUGS)[number];
export type AnyLeadBoardStageSlug = LeadBoardStageSlug | LegacyLeadBoardStageSlug;

export const LEAD_BOARD_STAGE_SLUGS: LeadBoardStageSlug[] = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
];

export const ALL_LEAD_BOARD_STAGE_SLUGS: AnyLeadBoardStageSlug[] = [
  ...LEGACY_LEAD_BOARD_STAGE_SLUGS,
  ...LEAD_BOARD_STAGE_SLUGS,
];

const LEGACY_LEAD_STAGE_LABELS: Record<LegacyLeadBoardStageSlug, string> = {
  lead_new: "New Lead",
  company_pre_qualified: "Qualified Lead",
  scoping_in_progress: "Qualified Lead",
  pre_qual_value_assigned: "Qualified Lead",
  lead_go_no_go: "Sales Validation Stage",
  qualified_for_opportunity: "Sales Validation Stage",
};

export function getLeadBoardStageLabel(slug: AnyLeadBoardStageSlug) {
  if (slug in CRM_OWNED_LEAD_STAGE_LABELS) {
    return CRM_OWNED_LEAD_STAGE_LABELS[slug as keyof typeof CRM_OWNED_LEAD_STAGE_LABELS];
  }

  return LEGACY_LEAD_STAGE_LABELS[slug as LegacyLeadBoardStageSlug];
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
  const isBoardStage =
    slug != null && ALL_LEAD_BOARD_STAGE_SLUGS.includes(slug as AnyLeadBoardStageSlug);

  return {
    stage,
    slug,
    label:
      slug && ALL_LEAD_BOARD_STAGE_SLUGS.includes(slug as AnyLeadBoardStageSlug)
        ? getLeadBoardStageLabel(slug as AnyLeadBoardStageSlug)
        : stage?.name ?? "Lead",
    isCrmOwnedLeadStage,
    isBoardStage,
    isOpportunityStage: slug === "opportunity",
  };
}

export function getWorkflowRouteLabel(route: "normal" | "service") {
  return route === "service" ? "Service" : "Standard";
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
    (BID_BOARD_MIRRORED_STAGE_SLUGS.includes(
      slug as (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number]
    ) ||
      LEGACY_MIRRORED_DEAL_STAGE_SLUGS.includes(
        slug as (typeof LEGACY_MIRRORED_DEAL_STAGE_SLUGS)[number]
      ));
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
    ) ||
    LEGACY_MIRRORED_DEAL_STAGE_SLUGS.includes(
      stage.slug as (typeof LEGACY_MIRRORED_DEAL_STAGE_SLUGS)[number]
    )
  ) {
    return {
      label: "Bid Board mirror",
      secondaryLabel: "Synced from Bid Board",
      tone: "mirror" as const,
    };
  }

  return null;
}
