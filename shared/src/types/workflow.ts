export const WORKFLOW_ROUTES = ["normal", "service"] as const;
export type WorkflowRoute = (typeof WORKFLOW_ROUTES)[number];

export const SALES_WORKFLOW_ROUTES = WORKFLOW_ROUTES;
export type SalesWorkflowRoute = WorkflowRoute;

export const WORKFLOW_FAMILIES = ["lead", "standard_deal", "service_deal"] as const;
export type WorkflowFamily = (typeof WORKFLOW_FAMILIES)[number];

export const WORKFLOW_SYSTEMS_OF_RECORD = ["crm", "bid_board"] as const;
export type WorkflowSystemOfRecord = (typeof WORKFLOW_SYSTEMS_OF_RECORD)[number];

export const WORKFLOW_OUTCOME_CATEGORIES = ["active", "handed_off", "won", "lost"] as const;
export type WorkflowOutcomeCategory = (typeof WORKFLOW_OUTCOME_CATEGORIES)[number];

export const CANONICAL_LEAD_STAGE_SLUGS = [
  "new_lead",
  "qualified_lead",
  "sales_validation",
  "opportunity",
] as const;
export type CanonicalLeadStageSlug = (typeof CANONICAL_LEAD_STAGE_SLUGS)[number];

export const CANONICAL_DEAL_STAGE_SLUGS = [
  "opportunity",
  "estimate_in_progress",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "sent_to_production",
  "service_sent_to_production",
  "production_lost",
  "service_lost",
] as const;
export type CanonicalDealStageSlug = (typeof CANONICAL_DEAL_STAGE_SLUGS)[number];

export type CanonicalWorkflowStageSlug = CanonicalLeadStageSlug | CanonicalDealStageSlug;

export const CANONICAL_TERMINAL_DEAL_STAGE_SLUGS = [
  "sent_to_production",
  "service_sent_to_production",
  "production_lost",
  "service_lost",
] as const;
export type CanonicalTerminalDealStageSlug = (typeof CANONICAL_TERMINAL_DEAL_STAGE_SLUGS)[number];

export const CRM_OWNED_CANONICAL_DEAL_STAGE_SLUGS = ["opportunity"] as const;
export type CrmOwnedCanonicalDealStageSlug = (typeof CRM_OWNED_CANONICAL_DEAL_STAGE_SLUGS)[number];

export const BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUGS = [
  "estimate_in_progress",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "sent_to_production",
  "service_sent_to_production",
  "production_lost",
  "service_lost",
] as const;
export type BidBoardOwnedCanonicalDealStageSlug =
  (typeof BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUGS)[number];

export interface CanonicalLeadWorkflowContract {
  slug: CanonicalLeadStageSlug;
  label: string;
  workflowFamily: "lead";
  systemOfRecord: "crm";
  outcomeCategory: "active";
  isTerminal: false;
}

export interface CanonicalDealWorkflowContract {
  slug: CanonicalDealStageSlug;
  label: string;
  workflowRoutes: readonly WorkflowRoute[];
  systemOfRecord: WorkflowSystemOfRecord;
  outcomeCategory: WorkflowOutcomeCategory;
  isTerminal: boolean;
}

export const CANONICAL_LEAD_WORKFLOW_CONTRACTS = [
  {
    slug: "new_lead",
    label: "New Lead",
    workflowFamily: "lead",
    systemOfRecord: "crm",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "qualified_lead",
    label: "Qualified Lead",
    workflowFamily: "lead",
    systemOfRecord: "crm",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "sales_validation",
    label: "Sales Validation",
    workflowFamily: "lead",
    systemOfRecord: "crm",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "opportunity",
    label: "Opportunity",
    workflowFamily: "lead",
    systemOfRecord: "crm",
    outcomeCategory: "active",
    isTerminal: false,
  },
] as const satisfies readonly CanonicalLeadWorkflowContract[];

export const CANONICAL_DEAL_WORKFLOW_CONTRACTS = [
  {
    slug: "opportunity",
    label: "Opportunity",
    workflowRoutes: WORKFLOW_ROUTES,
    systemOfRecord: "crm",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "estimate_in_progress",
    label: "Estimate In Progress",
    workflowRoutes: ["normal"],
    systemOfRecord: "bid_board",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "service_estimating",
    label: "Service Estimating",
    workflowRoutes: ["service"],
    systemOfRecord: "bid_board",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "estimate_under_review",
    label: "Estimate Under Review",
    workflowRoutes: WORKFLOW_ROUTES,
    systemOfRecord: "bid_board",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "estimate_sent_to_client",
    label: "Estimate Sent To Client",
    workflowRoutes: WORKFLOW_ROUTES,
    systemOfRecord: "bid_board",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "sent_to_production",
    label: "Sent To Production",
    workflowRoutes: ["normal"],
    systemOfRecord: "bid_board",
    outcomeCategory: "handed_off",
    isTerminal: true,
  },
  {
    slug: "service_sent_to_production",
    label: "Service Sent To Production",
    workflowRoutes: ["service"],
    systemOfRecord: "bid_board",
    outcomeCategory: "handed_off",
    isTerminal: true,
  },
  {
    slug: "production_lost",
    label: "Production Lost",
    workflowRoutes: ["normal"],
    systemOfRecord: "bid_board",
    outcomeCategory: "lost",
    isTerminal: true,
  },
  {
    slug: "service_lost",
    label: "Service Lost",
    workflowRoutes: ["service"],
    systemOfRecord: "bid_board",
    outcomeCategory: "lost",
    isTerminal: true,
  },
] as const satisfies readonly CanonicalDealWorkflowContract[];

const CANONICAL_LEAD_STAGE_SLUG_SET = new Set<string>(CANONICAL_LEAD_STAGE_SLUGS);
const CANONICAL_DEAL_STAGE_SLUG_SET = new Set<string>(CANONICAL_DEAL_STAGE_SLUGS);
const CANONICAL_TERMINAL_DEAL_STAGE_SLUG_SET = new Set<string>(CANONICAL_TERMINAL_DEAL_STAGE_SLUGS);

export function workflowFamilyForRoute(
  workflowRoute: WorkflowRoute
): Extract<WorkflowFamily, "standard_deal" | "service_deal"> {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

export function isCanonicalLeadStageSlug(stageSlug: string): stageSlug is CanonicalLeadStageSlug {
  return CANONICAL_LEAD_STAGE_SLUG_SET.has(stageSlug);
}

export function isCanonicalDealStageSlug(stageSlug: string): stageSlug is CanonicalDealStageSlug {
  return CANONICAL_DEAL_STAGE_SLUG_SET.has(stageSlug);
}

export function getWorkflowFamilyForStage(
  stageSlug: string,
  workflowRoute?: WorkflowRoute | null
): WorkflowFamily | null {
  if (stageSlug === "opportunity" && workflowRoute) {
    return workflowFamilyForRoute(workflowRoute);
  }

  if (isCanonicalLeadStageSlug(stageSlug)) {
    return "lead";
  }

  if (isCanonicalDealStageSlug(stageSlug)) {
    return workflowRoute ? workflowFamilyForRoute(workflowRoute) : null;
  }

  return null;
}

export function isTerminalWorkflowStage(stageSlug: string): stageSlug is CanonicalTerminalDealStageSlug {
  return CANONICAL_TERMINAL_DEAL_STAGE_SLUG_SET.has(stageSlug);
}
