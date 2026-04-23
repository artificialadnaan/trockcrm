import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CRM_OWNED_LEAD_STAGE_LABELS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
  NORMAL_DEAL_STAGE_SLUGS,
  SERVICE_DEAL_STAGE_SLUGS,
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
export type AnyLeadBoardStageSlug = (typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number];

export const LEAD_BOARD_STAGE_SLUGS: LeadBoardStageSlug[] = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
];
export const ALL_LEAD_BOARD_STAGE_SLUGS = CRM_OWNED_LEAD_STAGE_SLUGS;

type WorkflowRouteLike = "normal" | "service" | null | undefined;
type CanonicalDealBoardStageSlug =
  | (typeof NORMAL_DEAL_STAGE_SLUGS)[number]
  | (typeof SERVICE_DEAL_STAGE_SLUGS)[number];

export function getLeadBoardStageLabel(slug: LeadBoardStageSlug) {
  return CRM_OWNED_LEAD_STAGE_LABELS[slug];
}

function normalizeWorkflowRoute(workflowRoute: WorkflowRouteLike): "normal" | "service" {
  return workflowRoute === "service" ? "service" : "normal";
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
  workflowRoute: WorkflowRouteLike
) {
  const normalizedRoute = normalizeWorkflowRoute(workflowRoute);
  return (
    stageSlug === "estimating" ||
    stageSlug === (normalizedRoute === "service" ? "service_estimating" : "estimate_in_progress")
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

export function normalizeDealStageSlug(
  stageSlug: string | null | undefined,
  workflowRoute: WorkflowRouteLike
): CanonicalDealBoardStageSlug | null {
  if (!stageSlug) return null;

  const normalizedRoute = normalizeWorkflowRoute(workflowRoute);

  switch (stageSlug) {
    case "opportunity":
      return "opportunity";
    case "estimate_in_progress":
    case "service_estimating":
    case "estimate_under_review":
    case "estimate_sent_to_client":
    case "sent_to_production":
    case "service_sent_to_production":
    case "production_lost":
    case "service_lost":
      return stageSlug;
    case "estimating":
      return normalizedRoute === "service" ? "service_estimating" : "estimate_in_progress";
    case "bid_sent":
      return "estimate_sent_to_client";
    case "in_production":
    case "close_out":
    case "closed_won":
      return normalizedRoute === "service" ? "service_sent_to_production" : "sent_to_production";
    case "closed_lost":
      return normalizedRoute === "service" ? "service_lost" : "production_lost";
    case "service_complete":
      return "service_sent_to_production";
    default:
      return null;
  }
}

export function getCanonicalDealStageSlugs(workflowRoute: WorkflowRouteLike) {
  return normalizeWorkflowRoute(workflowRoute) === "service"
    ? [...SERVICE_DEAL_STAGE_SLUGS]
    : [...NORMAL_DEAL_STAGE_SLUGS];
}

export function getDealBoardStageSlugs() {
  return [...NORMAL_DEAL_STAGE_SLUGS];
}

export function getDealStageLabelBySlug(slug: CanonicalDealBoardStageSlug) {
  switch (slug) {
    case "opportunity":
      return "Opportunity";
    case "estimate_in_progress":
      return "Estimate in Progress";
    case "service_estimating":
      return "Service - Estimating";
    case "estimate_under_review":
      return "Estimate Under Review";
    case "estimate_sent_to_client":
      return "Estimate Sent to Client";
    case "sent_to_production":
      return "Sent to Production";
    case "service_sent_to_production":
      return "Service - Sent to Production";
    case "production_lost":
      return "Production Lost";
    case "service_lost":
      return "Service - Lost";
  }
}

export function getDealStageMetadata(
  deal: {
    stageId: string;
    workflowRoute: WorkflowRouteLike;
    isBidBoardOwned: boolean;
    bidBoardStageSlug: string | null;
    readOnlySyncedAt: string | null;
  },
  stages: Array<{ id: string; name: string; slug: string }>
) {
  const stage = stages.find((entry) => entry.id === deal.stageId) ?? null;
  const slug =
    normalizeDealStageSlug(deal.bidBoardStageSlug, deal.workflowRoute) ??
    normalizeDealStageSlug(stage?.slug ?? null, deal.workflowRoute) ??
    stage?.slug ??
    null;
  const isMirroredStage = isBidBoardMirroredStageSlug(slug);
  const isOpportunityStage = slug === "opportunity";
  const isReadOnlyInCrm = isMirroredStage || Boolean(deal.isBidBoardOwned || deal.readOnlySyncedAt);

  return {
    stage,
    slug,
    label:
      slug != null && normalizeDealStageSlug(slug, deal.workflowRoute)
        ? getDealStageLabelBySlug(normalizeDealStageSlug(slug, deal.workflowRoute)!)
        : stage?.name ?? "Deal",
    isOpportunityStage,
    isMirroredStage,
    isReadOnlyInCrm,
    sourceOfTruth: isReadOnlyInCrm ? ("bid_board" as const) : ("crm" as const),
    routeLabel: getWorkflowRouteLabel(normalizeWorkflowRoute(deal.workflowRoute)),
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
