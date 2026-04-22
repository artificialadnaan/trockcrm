import { WORKFLOW_ROUTES } from "@trock-crm/shared/types";

export const CRM_OWNED_LEAD_STAGE_SLUGS = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
  "opportunity",
] as const;

export const CRM_OWNED_LEAD_STAGE_LABELS = {
  new_lead: "New Lead",
  qualified_lead: "Qualified Lead",
  sales_validation_stage: "Sales Validation Stage",
  opportunity: "Opportunity",
} as const;

export const SALES_WORKFLOW_PIPELINE_TYPES = ["service", "normal"] as const;

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

export const BID_BOARD_MIRRORED_STAGE_SLUGS = [
  "estimating",
  "bid_sent",
  "in_production",
  "close_out",
  "closed_won",
  "closed_lost",
] as const;

export const SALES_WORKFLOW = {
  crmOwnedLeadStages: CRM_OWNED_LEAD_STAGE_LABELS,
  pipelineTypes: SALES_WORKFLOW_PIPELINE_TYPES,
  disqualificationReasons: SALES_WORKFLOW_DISQUALIFICATION_REASONS,
  bidBoardMirroredStages: BID_BOARD_MIRRORED_STAGE_SLUGS,
  workflowRoutes: WORKFLOW_ROUTES,
} as const;
