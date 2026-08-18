export const CRM_OWNED_LEAD_STAGE_SLUGS = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
  "opportunity",
] as const;
export type CrmOwnedLeadStageSlug = (typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number];

export const CRM_OWNED_LEAD_STAGE_LABELS = {
  new_lead: "New Lead",
  qualified_lead: "Qualified Lead",
  sales_validation_stage: "Sales Validation Stage",
  opportunity: "Opportunity",
} as const satisfies Record<CrmOwnedLeadStageSlug, string>;

export const SALES_WORKFLOW_PIPELINE_TYPES = ["service", "normal"] as const;
export type SalesWorkflowPipelineType = (typeof SALES_WORKFLOW_PIPELINE_TYPES)[number];

export const SALES_WORKFLOW_DISQUALIFICATION_REASONS = [
  "no_budget",
  "not_a_fit",
  "no_authority",
  "no_timeline",
  "duplicate",
  "unresponsive",
  "customer_declined",
  "other",
] as const;
export type SalesWorkflowDisqualificationReason =
  (typeof SALES_WORKFLOW_DISQUALIFICATION_REASONS)[number];

export const BID_BOARD_MIRRORED_STAGE_SLUGS = [
  "estimating",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
] as const;
export type BidBoardMirroredStageSlug = (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number];

export const NORMAL_DEAL_STAGE_SLUGS = [
  "opportunity",
  "estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
] as const;

export const SERVICE_DEAL_STAGE_SLUGS = [
  "opportunity",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
] as const;

export const SALES_WORKFLOW = {
  crmOwnedLeadStages: CRM_OWNED_LEAD_STAGE_LABELS,
  pipelineTypes: SALES_WORKFLOW_PIPELINE_TYPES,
  disqualificationReasons: SALES_WORKFLOW_DISQUALIFICATION_REASONS,
  bidBoardMirroredStages: BID_BOARD_MIRRORED_STAGE_SLUGS,
  normalDealStages: NORMAL_DEAL_STAGE_SLUGS,
  serviceDealStages: SERVICE_DEAL_STAGE_SLUGS,
} as const;

/** The canonical column slugs the /deals kanban renders, across both workflow routes. */
export type CanonicalDealBoardStageSlug =
  | (typeof NORMAL_DEAL_STAGE_SLUGS)[number]
  | (typeof SERVICE_DEAL_STAGE_SLUGS)[number];

/**
 * The BOARD's stage canonicalization: which kanban column a raw stage slug belongs to.
 *
 * SHARED, and deliberately so. This is the membership rule behind every /deals board column, and the
 * server now answers board-wide aggregates (the At-Risk KPI counts and the Pending RFP column) that have
 * to bucket rows into exactly the columns the client will render them in. A second copy on the server
 * would be two implementations of one rule whose failure mode is a KPI number that disagrees with the
 * column it links to — the class of bug this codebase keeps paying for. `client/src/lib/pipeline-
 * ownership.ts` re-exports this under its historical name `normalizeDealStageSlug`.
 *
 * Distinct from `toCanonicalDealStageSlug` in workflow.ts, which canonicalizes to the WORKFLOW contract
 * (route-gated, returns null for a route a stage does not belong to). This one is a total, route-aware
 * BOARD grouping that folds historical/mirrored aliases into their column: `dd` → opportunity,
 * `bid_sent` → estimate_sent_to_client, every won/lost alias → won/lost, and so on. Returns null for a
 * slug that belongs on no board column.
 */
export function normalizeDealBoardStageSlug(
  stageSlug: string | null | undefined,
  workflowRoute: "normal" | "service" | null | undefined
): CanonicalDealBoardStageSlug | null {
  if (!stageSlug) return null;

  const route = workflowRoute === "service" ? "service" : "normal";

  switch (stageSlug) {
    case "dd":
      return "opportunity";
    case "opportunity":
    case "contract":
    case "won":
    case "lost":
      return stageSlug;
    case "estimating":
    case "estimate_in_progress":
      return route === "service" ? "service_estimating" : "estimating";
    case "service_estimating":
    case "estimate_under_review":
    case "estimate_sent_to_client":
      return stageSlug;
    case "bid_sent":
      return "estimate_sent_to_client";
    case "service_estimate_under_review":
      return "estimate_under_review";
    case "service_estimate_sent_to_client":
      return "estimate_sent_to_client";
    case "contract_signed":
    case "service_contract_signed":
      return "contract";
    case "sent_to_production":
    case "service_sent_to_production":
    case "service_scheduled":
    case "in_production":
    case "close_out":
    case "closed_won":
    case "service_complete":
      return "won";
    case "deal_canceled":
    case "production_lost":
    case "service_lost":
    case "closed_lost":
      return "lost";
    default:
      return null;
  }
}
