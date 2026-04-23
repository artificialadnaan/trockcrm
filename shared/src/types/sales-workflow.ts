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
  "estimate_in_progress",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "sent_to_production",
  "service_sent_to_production",
  "production_lost",
  "service_lost",
] as const;
export type BidBoardMirroredStageSlug = (typeof BID_BOARD_MIRRORED_STAGE_SLUGS)[number];

export const SALES_WORKFLOW = {
  crmOwnedLeadStages: CRM_OWNED_LEAD_STAGE_LABELS,
  pipelineTypes: SALES_WORKFLOW_PIPELINE_TYPES,
  disqualificationReasons: SALES_WORKFLOW_DISQUALIFICATION_REASONS,
  bidBoardMirroredStages: BID_BOARD_MIRRORED_STAGE_SLUGS,
} as const;
