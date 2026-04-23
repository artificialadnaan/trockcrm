import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CANONICAL_DEAL_STAGE_LABELS,
  CANONICAL_DEAL_STAGE_SLUGS,
  CRM_OWNED_LEAD_STAGE_LABELS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
  NORMAL_DEAL_STAGE_SLUGS,
  SERVICE_DEAL_STAGE_SLUGS,
} from "./sales-workflow";

export const LEGACY_LEAD_BOARD_STAGE_SLUGS = [
  "lead_new",
  "company_pre_qualified",
  "scoping_in_progress",
  "pre_qual_value_assigned",
  "lead_go_no_go",
  "qualified_for_opportunity",
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
  const isBoardStage = slug != null && ALL_LEAD_BOARD_STAGE_SLUGS.includes(slug as AnyLeadBoardStageSlug);

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
  return route === "service" ? "Service" : "Normal";
}

const LEGACY_NORMAL_STAGE_SLUGS: Partial<Record<string, (typeof CANONICAL_DEAL_STAGE_SLUGS)[number]>> = {
  estimating: "estimate_in_progress",
  bid_sent: "estimate_sent_to_client",
  in_production: "sent_to_production",
  close_out: "sent_to_production",
  closed_won: "sent_to_production",
  closed_lost: "production_lost",
};

const LEGACY_SERVICE_STAGE_SLUGS: Partial<Record<string, (typeof CANONICAL_DEAL_STAGE_SLUGS)[number]>> = {
  estimating: "service_estimating",
  bid_sent: "estimate_sent_to_client",
  in_production: "service_sent_to_production",
  close_out: "service_sent_to_production",
  closed_won: "service_sent_to_production",
  closed_lost: "service_lost",
  service_proposal_sent: "estimate_sent_to_client",
  service_scheduled: "service_sent_to_production",
  service_complete: "service_sent_to_production",
};

export function getCanonicalDealStageSlugs(route: "normal" | "service") {
  return route === "service" ? SERVICE_DEAL_STAGE_SLUGS : NORMAL_DEAL_STAGE_SLUGS;
}

export function getDealBoardStageSlugs() {
  return [
    "opportunity",
    "service_estimating",
    "estimate_in_progress",
    "estimate_under_review",
    "estimate_sent_to_client",
    "service_sent_to_production",
    "sent_to_production",
    "service_lost",
    "production_lost",
  ] as const;
}

export function getDealStageLabelBySlug(slug: (typeof CANONICAL_DEAL_STAGE_SLUGS)[number]) {
  return CANONICAL_DEAL_STAGE_LABELS[slug];
}

export function normalizeDealStageSlug(
  slug: string | null | undefined,
  route: "normal" | "service"
): (typeof CANONICAL_DEAL_STAGE_SLUGS)[number] | null {
  if (!slug) {
    return null;
  }

  if (CANONICAL_DEAL_STAGE_SLUGS.includes(slug as (typeof CANONICAL_DEAL_STAGE_SLUGS)[number])) {
    return slug as (typeof CANONICAL_DEAL_STAGE_SLUGS)[number];
  }

  const legacyMap = route === "service" ? LEGACY_SERVICE_STAGE_SLUGS : LEGACY_NORMAL_STAGE_SLUGS;
  return legacyMap[slug] ?? null;
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
  const slug = normalizeDealStageSlug(
    deal.bidBoardStageSlug ?? stage?.slug ?? null,
    deal.workflowRoute
  );
  const isMirroredStage =
    slug != null &&
    BID_BOARD_MIRRORED_STAGE_SLUGS.includes(slug as (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number]);
  const isOpportunityStage = slug === "opportunity";
  const isReadOnlyInCrm = isMirroredStage || Boolean(deal.isBidBoardOwned || deal.readOnlySyncedAt);

  return {
    stage,
    slug,
    label:
      slug && slug in CANONICAL_DEAL_STAGE_LABELS
        ? CANONICAL_DEAL_STAGE_LABELS[slug as keyof typeof CANONICAL_DEAL_STAGE_LABELS]
        : stage?.name ?? "Deal",
    isOpportunityStage,
    isMirroredStage,
    isReadOnlyInCrm,
    sourceOfTruth: isReadOnlyInCrm ? ("bid_board" as const) : ("crm" as const),
    routeLabel: getWorkflowRouteLabel(deal.workflowRoute),
  };
}

export function getDealColumnOwnership(stage: { slug: string }) {
  const normalizedSlug = normalizeDealStageSlug(stage.slug, "normal") ?? normalizeDealStageSlug(stage.slug, "service");

  if (normalizedSlug === "opportunity") {
    return {
      label: "CRM editable",
      tone: "crm" as const,
    };
  }

  if (
    normalizedSlug != null &&
    BID_BOARD_MIRRORED_STAGE_SLUGS.includes(
      normalizedSlug as (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number]
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
