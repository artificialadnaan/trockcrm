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
  "estimating",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
] as const;
export type CanonicalDealStageSlug = (typeof CANONICAL_DEAL_STAGE_SLUGS)[number];

export type CanonicalWorkflowStageSlug = CanonicalLeadStageSlug | CanonicalDealStageSlug;

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
    slug: "estimating",
    label: "Estimating",
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
    label: "Estimate Sent to Client",
    workflowRoutes: WORKFLOW_ROUTES,
    systemOfRecord: "bid_board",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "contract",
    label: "Contract",
    workflowRoutes: WORKFLOW_ROUTES,
    systemOfRecord: "bid_board",
    outcomeCategory: "active",
    isTerminal: false,
  },
  {
    slug: "won",
    label: "Won",
    workflowRoutes: WORKFLOW_ROUTES,
    systemOfRecord: "bid_board",
    outcomeCategory: "won",
    isTerminal: true,
  },
  {
    slug: "lost",
    label: "Lost",
    workflowRoutes: WORKFLOW_ROUTES,
    systemOfRecord: "bid_board",
    outcomeCategory: "lost",
    isTerminal: true,
  },
] as const satisfies readonly CanonicalDealWorkflowContract[];

export const HISTORICAL_DEAL_STAGE_ALIAS_LABELS = {
  estimate_in_progress: "Estimating",
  service_estimate_under_review: "Estimate Under Review",
  service_estimate_sent_to_client: "Estimate Sent to Client",
  contract_signed: "Contract",
  service_contract_signed: "Contract",
  sent_to_production: "Won",
  service_sent_to_production: "Won",
  production_lost: "Lost",
  service_lost: "Lost",
  closed_won: "Won",
  closed_lost: "Lost",
} as const;
export type HistoricalDealStageAliasSlug = keyof typeof HISTORICAL_DEAL_STAGE_ALIAS_LABELS;

export const CANONICAL_DEAL_STAGE_LABELS = {
  ...(Object.fromEntries(
    CANONICAL_DEAL_WORKFLOW_CONTRACTS.map((contract) => [contract.slug, contract.label])
  ) as Record<CanonicalDealStageSlug, string>),
  ...HISTORICAL_DEAL_STAGE_ALIAS_LABELS,
} as const satisfies Record<CanonicalDealStageSlug | HistoricalDealStageAliasSlug, string>;
export type DealStageSlugWithHistoricalAliases =
  | CanonicalDealStageSlug
  | HistoricalDealStageAliasSlug;

type CanonicalDealWorkflowContractRecord = (typeof CANONICAL_DEAL_WORKFLOW_CONTRACTS)[number];

export type CanonicalTerminalDealStageSlug = Extract<
  CanonicalDealWorkflowContractRecord,
  { isTerminal: true }
>["slug"];

export type CrmOwnedCanonicalDealStageSlug = Extract<
  CanonicalDealWorkflowContractRecord,
  { systemOfRecord: "crm" }
>["slug"];

export type BidBoardOwnedCanonicalDealStageSlug = Extract<
  CanonicalDealWorkflowContractRecord,
  { systemOfRecord: "bid_board" }
>["slug"];

export const CANONICAL_TERMINAL_DEAL_STAGE_SLUGS = CANONICAL_DEAL_WORKFLOW_CONTRACTS
  .filter((contract) => contract.isTerminal)
  .map((contract) => contract.slug) as readonly CanonicalTerminalDealStageSlug[];

export const CRM_OWNED_CANONICAL_DEAL_STAGE_SLUGS = CANONICAL_DEAL_WORKFLOW_CONTRACTS
  .filter((contract) => contract.systemOfRecord === "crm")
  .map((contract) => contract.slug) as readonly CrmOwnedCanonicalDealStageSlug[];

export const BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUGS = CANONICAL_DEAL_WORKFLOW_CONTRACTS
  .filter((contract) => contract.systemOfRecord === "bid_board")
  .map((contract) => contract.slug) as readonly BidBoardOwnedCanonicalDealStageSlug[];

export const LEGACY_LEAD_STAGE_TO_CANONICAL_STAGE = {
  new_lead: "new_lead",
  qualified_lead: "qualified_lead",
  sales_validation_stage: "sales_validation",
  opportunity: "opportunity",
} as const satisfies Record<string, CanonicalLeadStageSlug>;
export type LegacyLeadStageSlug = keyof typeof LEGACY_LEAD_STAGE_TO_CANONICAL_STAGE;

export const LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE = {
  normal: {
    dd: "opportunity",
    estimating: "estimating",
    estimate_in_progress: "estimating",
    bid_sent: "estimate_sent_to_client",
    service_estimate_under_review: "estimate_under_review",
    service_estimate_sent_to_client: "estimate_sent_to_client",
    contract_signed: "contract",
    service_contract_signed: "contract",
    in_production: "won",
    close_out: "won",
    sent_to_production: "won",
    service_sent_to_production: "won",
    closed_won: "won",
    production_lost: "lost",
    service_lost: "lost",
    closed_lost: "lost",
  },
  service: {
    dd: "opportunity",
    estimating: "service_estimating",
    estimate_in_progress: "service_estimating",
    bid_sent: "estimate_sent_to_client",
    service_estimate_under_review: "estimate_under_review",
    service_estimate_sent_to_client: "estimate_sent_to_client",
    contract_signed: "contract",
    service_contract_signed: "contract",
    in_production: "won",
    close_out: "won",
    sent_to_production: "won",
    service_sent_to_production: "won",
    closed_won: "won",
    production_lost: "lost",
    service_lost: "lost",
    closed_lost: "lost",
  },
} as const satisfies Record<WorkflowRoute, Record<string, CanonicalDealStageSlug>>;
export type LegacyDealStageSlug =
  | keyof (typeof LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE)["normal"]
  | keyof (typeof LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE)["service"];

export type LegacyWorkflowStageSlug = LegacyLeadStageSlug | LegacyDealStageSlug;

const CANONICAL_LEAD_STAGE_SLUG_SET = new Set<string>(CANONICAL_LEAD_STAGE_SLUGS);
const CANONICAL_DEAL_STAGE_SLUG_SET = new Set<string>(CANONICAL_DEAL_STAGE_SLUGS);
const CANONICAL_TERMINAL_DEAL_STAGE_SLUG_SET = new Set<string>(CANONICAL_TERMINAL_DEAL_STAGE_SLUGS);
const CRM_OWNED_CANONICAL_DEAL_STAGE_SLUG_SET = new Set<string>(CRM_OWNED_CANONICAL_DEAL_STAGE_SLUGS);
const BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUG_SET = new Set<string>(BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUGS);
const CANONICAL_DEAL_WORKFLOW_CONTRACTS_BY_SLUG = new Map(
  CANONICAL_DEAL_WORKFLOW_CONTRACTS.map((contract) => [contract.slug, contract] as const)
);

function contractAllowsWorkflowRoute(
  contract: CanonicalDealWorkflowContractRecord,
  workflowRoute: WorkflowRoute
): boolean {
  return (contract.workflowRoutes as readonly WorkflowRoute[]).includes(workflowRoute);
}

export function workflowFamilyForRoute(
  workflowRoute: WorkflowRoute
): Extract<WorkflowFamily, "standard_deal" | "service_deal"> {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

export function getCanonicalEstimatingBoundaryStageSlug(
  workflowRoute: WorkflowRoute
): Extract<CanonicalDealStageSlug, "estimating" | "service_estimating"> {
  return workflowRoute === "service" ? "service_estimating" : "estimating";
}

export function isCanonicalLeadStageSlug(stageSlug: string): stageSlug is CanonicalLeadStageSlug {
  return CANONICAL_LEAD_STAGE_SLUG_SET.has(stageSlug);
}

export function isCanonicalDealStageSlug(stageSlug: string): stageSlug is CanonicalDealStageSlug {
  return CANONICAL_DEAL_STAGE_SLUG_SET.has(stageSlug);
}

export function toCanonicalLeadStageSlug(stageSlug: string): CanonicalLeadStageSlug | null {
  if (isCanonicalLeadStageSlug(stageSlug)) {
    return stageSlug;
  }

  return LEGACY_LEAD_STAGE_TO_CANONICAL_STAGE[stageSlug as LegacyLeadStageSlug] ?? null;
}

export function toCanonicalDealStageSlug(
  stageSlug: string,
  workflowRoute?: WorkflowRoute | null
): DealStageSlugWithHistoricalAliases | null {
  if (isCanonicalDealStageSlug(stageSlug)) {
    if (workflowRoute === "service" && stageSlug === "estimating") {
      return "service_estimating";
    }

    const contract = CANONICAL_DEAL_WORKFLOW_CONTRACTS_BY_SLUG.get(stageSlug);
    if (!contract) {
      return null;
    }

    if (workflowRoute && !contractAllowsWorkflowRoute(contract, workflowRoute)) {
      return null;
    }

    return stageSlug;
  }

  if (!workflowRoute) {
    return null;
  }

  const canonicalStageSlug =
    LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE[workflowRoute][stageSlug as LegacyDealStageSlug] ?? null;

  if (!canonicalStageSlug) {
    return null;
  }

  const contract = CANONICAL_DEAL_WORKFLOW_CONTRACTS_BY_SLUG.get(canonicalStageSlug);
  if (!contract || !contractAllowsWorkflowRoute(contract, workflowRoute)) {
    return null;
  }

  return canonicalStageSlug;
}

export function toCanonicalWorkflowStageSlug(
  stageSlug: string,
  workflowRoute?: WorkflowRoute | null
): CanonicalLeadStageSlug | DealStageSlugWithHistoricalAliases | null {
  return toCanonicalLeadStageSlug(stageSlug) ?? toCanonicalDealStageSlug(stageSlug, workflowRoute);
}

export function getWorkflowFamilyForStage(
  stageSlug: string,
  workflowRoute?: WorkflowRoute | null
): WorkflowFamily | null {
  const canonicalStageSlug = toCanonicalWorkflowStageSlug(stageSlug, workflowRoute);

  if (!canonicalStageSlug) {
    return null;
  }

  if (canonicalStageSlug === "opportunity") {
    if (!workflowRoute) {
      return null;
    }

    return workflowFamilyForRoute(workflowRoute);
  }

  if (isCanonicalLeadStageSlug(canonicalStageSlug)) {
    return "lead";
  }

  if (isCanonicalDealStageSlug(canonicalStageSlug)) {
    const contract = CANONICAL_DEAL_WORKFLOW_CONTRACTS_BY_SLUG.get(canonicalStageSlug);
    if (!contract) {
      return null;
    }

    if (workflowRoute) {
      return contractAllowsWorkflowRoute(contract, workflowRoute)
        ? workflowFamilyForRoute(workflowRoute)
        : null;
    }

    if (contract.workflowRoutes.length === 1) {
      return workflowFamilyForRoute(contract.workflowRoutes[0]);
    }

    return null;
  }

  return null;
}

export function isCrmOwnedDealStage(
  stageSlug: string,
  workflowRoute?: WorkflowRoute | null
): boolean {
  const canonicalStageSlug = toCanonicalDealStageSlug(stageSlug, workflowRoute);
  return canonicalStageSlug !== null && CRM_OWNED_CANONICAL_DEAL_STAGE_SLUG_SET.has(canonicalStageSlug);
}

export function isBidBoardOwnedDealStage(
  stageSlug: string,
  workflowRoute?: WorkflowRoute | null
): boolean {
  const canonicalStageSlug = toCanonicalDealStageSlug(stageSlug, workflowRoute);
  return (
    canonicalStageSlug !== null &&
    BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUG_SET.has(canonicalStageSlug)
  );
}

export function isCanonicalEstimatingBoundaryStage(
  stageSlug: string,
  workflowRoute: WorkflowRoute
): boolean {
  return (
    toCanonicalDealStageSlug(stageSlug, workflowRoute) ===
    getCanonicalEstimatingBoundaryStageSlug(workflowRoute)
  );
}

export function isTerminalWorkflowStage(
  stageSlug: string,
  workflowRoute?: WorkflowRoute | null
): boolean {
  const canonicalStageSlug = toCanonicalDealStageSlug(stageSlug, workflowRoute);
  return canonicalStageSlug !== null && CANONICAL_TERMINAL_DEAL_STAGE_SLUG_SET.has(canonicalStageSlug);
}
