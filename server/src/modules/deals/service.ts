import { randomUUID } from "node:crypto";
import { eq, and, desc, asc, ilike, inArray, sql, or, isNull, not } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealHistory,
  dealStageHistory,
  dealApprovals,
  changeOrders,
  pipelineStageConfig,
  contacts,
  leads,
  users,
  userOfficeAccess,
  tasks,
  jobQueue,
} from "@trock-crm/shared/schema";
import {
  DOMAIN_EVENTS,
  type DealContractSignedEventPayload,
  type WorkflowRoute,
} from "@trock-crm/shared/types";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { calculateCommissionForDeal } from "../commissions/service.js";
import { getActiveProjectTypes, getStageById, getStageBySlug, resolveActiveProjectTypeValue } from "../pipeline/service.js";
import { evaluatePostConversionEnrichment } from "./post-conversion-enrichment.js";
import { createAssignmentTaskIfNeeded } from "../assignment-tasks/service.js";
import { generateDealNumberForProject } from "../../services/projectNumber.js";
import { isContractSignedHandoffEnabled } from "../../config/feature-flags.js";

// Type alias for the tenant-scoped Drizzle instance
type TenantDb = NodePgDatabase<typeof schema>;
type DealRow = typeof deals.$inferSelect;
type PipelineStageRow = typeof pipelineStageConfig.$inferSelect;
const contractSignedDateForReporting = sql`COALESCE(contract_signed_at::date, contract_signed_date)`;

export interface DealFilters {
  search?: string;
  stageIds?: string[];
  assignedRepId?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  isActive?: boolean;
  // Inclusive YYYY-MM-DD bounds against deals.contract_signed_at::date, with
  // deals.contract_signed_date as a transition fallback.
  contractSignedFrom?: string;
  contractSignedTo?: string;
  sortBy?: "name" | "created_at" | "updated_at" | "awarded_amount" | "stage_entered_at" | "expected_close_date" | "contract_signed_date";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface PipelineTerminalDateFilters {
  wonSince?: string;
  wonUntil?: string;
  lostSince?: string;
  lostUntil?: string;
  now?: Date;
}

export interface CreateDealInput {
  name: string;
  stageId: string;
  assignedRepId: string;
  actorUserId?: string;
  officeId?: string; // Active office — used to validate assignee has access
  companyId?: string;
  propertyId?: string;
  sourceLeadId?: string;
  sourceLeadWriteMode?: "direct" | "lead_conversion";
  workflowRoute?: WorkflowRoute;
  migrationMode?: boolean;
  primaryContactId?: string;
  ddEstimate?: string;
  bidEstimate?: string;
  awardedAmount?: string;
  description?: string;
  propertyAddress?: string;
  propertyCity?: string;
  propertyState?: string;
  propertyZip?: string;
  officeCode: string;
  projectType?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  winProbability?: number;
  expectedCloseDate?: string;
}

export interface UpdateDealInput {
  name?: string;
  assignedRepId?: string;
  primaryContactId?: string | null;
  sourceLeadId?: string | null;
  companyId?: string | null;
  propertyId?: string | null;
  workflowRoute?: WorkflowRoute;
  migrationMode?: boolean;
  ddEstimate?: string | null;
  bidEstimate?: string | null;
  awardedAmount?: string | null;
  description?: string | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
  projectType?: string | null;
  projectTypeId?: string | null;
  regionId?: string | null;
  source?: string | null;
  winProbability?: number | null;
  expectedCloseDate?: string | null;
  proposalStatus?: string | null;
  proposalNotes?: string | null;
  estimatingSubstage?: string | null;
}

export const VALID_PROPOSAL_STATUSES = [
  "not_started",
  "drafting",
  "sent",
  "under_review",
  "revision_requested",
  "accepted",
  "signed",
  "rejected",
] as const;
export const VALID_ESTIMATING_SUBSTAGES = [
  "scope_review",
  "site_visit",
  "missing_info",
  "building_estimate",
  "under_review",
  "sent_to_client",
] as const;
const WON_TERMINAL_STAGE_SLUGS = [
  "won",
  "sent_to_production",
  "service_sent_to_production",
  "closed_won",
] as const;
const LOST_TERMINAL_STAGE_SLUGS = [
  "lost",
  "production_lost",
  "service_lost",
  "closed_lost",
] as const;
const VALID_PROPOSAL_STATUS_SET = new Set<string>(VALID_PROPOSAL_STATUSES);
const VALID_ESTIMATING_SUBSTAGE_SET = new Set<string>(VALID_ESTIMATING_SUBSTAGES);
export const BID_BOARD_CRM_EDITABLE_FIELDS = [
  "deal details",
  "files",
  "activity",
  "notes",
] as const;
export const BID_BOARD_MIRRORED_FIELDS = [
  "stage progression",
  "proposal status",
  "estimating progress",
  "estimate amounts",
  "downstream mirror metadata",
] as const;
export const BID_BOARD_STAGE_READ_ONLY_MESSAGE =
  "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.";
export const BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE =
  "Estimating stage configuration is required to enforce the Bid Board ownership boundary.";
const BID_BOARD_OWNED_UPDATE_FIELD_LABELS: Partial<Record<keyof UpdateDealInput, string>> = {
  ddEstimate: "DD estimate",
  bidEstimate: "Bid estimate",
  awardedAmount: "Awarded amount",
  estimatingSubstage: "Estimating progress",
  proposalStatus: "Proposal status",
};

function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseIsoDateParam(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolvePipelineTerminalDateFilters(input: PipelineTerminalDateFilters = {}) {
  const now = input.now ?? new Date();
  const defaultSince = addUtcDays(startOfUtcDay(now), -30);

  return {
    won: {
      since: parseIsoDateParam(input.wonSince) ?? defaultSince,
      until: parseIsoDateParam(input.wonUntil),
    },
    lost: {
      since: parseIsoDateParam(input.lostSince) ?? defaultSince,
      until: parseIsoDateParam(input.lostUntil),
    },
  };
}

async function assertValidProjectType(value: string | null | undefined): Promise<string> {
  const normalized = await resolveActiveProjectTypeValue(value);
  if (!normalized) {
    throw new AppError(400, `Invalid project type: ${value ?? ""}`.trim());
  }

  return normalized;
}

function assertValidOfficeCode(value: string | null | undefined): "dfw" | "atl" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized !== "dfw" && normalized !== "atl") {
    throw new AppError(400, "officeCode must be 'dfw' or 'atl'");
  }

  return normalized;
}

function resolveIntendedProjectNumberFromCode(
  issuedProjectNumber: string | null | undefined,
  projectTypeCode: string
): string | null {
  const match = String(issuedProjectNumber ?? "").match(/^([A-Z]{2,4})-[1-9]-(\d{5})-([a-z]+)$/i);
  if (!match || !/^[1-9]$/.test(projectTypeCode)) {
    return null;
  }

  const [, officeCode, julianDate, suffix] = match;
  const intended = `${officeCode.toLowerCase()}-${projectTypeCode}-${julianDate}-${suffix.toLowerCase()}`;
  return intended === issuedProjectNumber ? null : intended;
}

async function isAtOrBeyondOpportunity(stageId: string | null | undefined) {
  if (!stageId) return true;

  const [stage, opportunity] = await Promise.all([
    getStageById(stageId),
    getStageBySlug("opportunity", "standard_deal"),
  ]);

  if (!stage || !opportunity) {
    return true;
  }

  if (stage.workflowFamily !== opportunity.workflowFamily) {
    return stage.workflowFamily !== "lead";
  }

  return stage.displayOrder >= opportunity.displayOrder;
}

async function resolveProjectTypeConfigById(projectTypeId: string | null | undefined) {
  if (!projectTypeId) return null;
  const projectTypes = await getActiveProjectTypes();
  return projectTypes.find((projectType) => projectType.id === projectTypeId) ?? null;
}

async function resolveProjectTypeConfigByValue(value: string | null | undefined) {
  const normalized = await resolveActiveProjectTypeValue(value);
  if (!normalized) return null;

  const projectTypes = await getActiveProjectTypes();
  return (
    projectTypes.find((projectType) => {
      const name = projectType.name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
      const slug = projectType.slug.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
      return name === normalized || slug === normalized;
    }) ?? null
  );
}

export async function applyProjectTypeChange(
  tenantDb: TenantDb,
  deal: Pick<
    DealRow,
    "id" | "dealNumber" | "stageId" | "projectTypeId" | "projectType" | "intendedProjectNumber"
  >,
  newProjectTypeId: string | null,
  actor: { id: string; role: string },
  options: { projectTypeValue?: string | null } = {}
) {
  if (await isAtOrBeyondOpportunity(deal.stageId)) {
    if (actor.role !== "admin") {
      throw new AppError(403, "Only admins can edit project type after Opportunity");
    }
    if (!newProjectTypeId && options.projectTypeValue === undefined) {
      throw new AppError(400, "projectType cannot be cleared after Opportunity");
    }
  }

  const projectType = options.projectTypeValue
    ? await resolveProjectTypeConfigByValue(options.projectTypeValue)
    : await resolveProjectTypeConfigById(newProjectTypeId);

  if (!projectType) {
    throw new AppError(400, "Invalid project type");
  }

  const nextProjectTypeId = projectType.id;
  const nextProjectTypeValue = projectType.name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  const nextIntendedProjectNumber = resolveIntendedProjectNumberFromCode(
    deal.dealNumber,
    projectType.code ?? ""
  );

  if (
    nextProjectTypeId === (deal.projectTypeId ?? null) &&
    nextProjectTypeValue === (deal.projectType ?? null) &&
    nextIntendedProjectNumber === (deal.intendedProjectNumber ?? null)
  ) {
    return {};
  }

  await tenantDb.insert(dealHistory).values({
    dealId: deal.id,
    fieldName: "project_type",
    oldValue: JSON.stringify({
      oldProjectTypeId: deal.projectTypeId ?? null,
      oldProjectType: deal.projectType ?? null,
      oldIntendedProjectNumber: deal.intendedProjectNumber ?? null,
    }),
    newValue: JSON.stringify({
      newProjectTypeId: nextProjectTypeId,
      newProjectType: nextProjectTypeValue,
      newIntendedProjectNumber: nextIntendedProjectNumber,
    }),
    changedBy: actor.id,
    changedAt: new Date(),
  });

  return {
    projectTypeId: nextProjectTypeId,
    projectType: nextProjectTypeValue,
    intendedProjectNumber: nextIntendedProjectNumber,
  };
}

function estimatingBoundaryStageSlugForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_estimating" : "estimate_in_progress";
}

type WorkspaceScope = "mine" | "team" | "all";

export interface DealBoardInput {
  role: string;
  userId: string;
  activeOfficeId: string;
  scope: WorkspaceScope;
  includeDd?: boolean;
}

export interface DealStagePageInput extends DealBoardInput {
  stageId: string;
  page: number;
  pageSize: number;
  search?: string;
  assignedRepId?: string;
  regionId?: string;
  workflowRoute?: string;
  updatedFrom?: string;
  updatedTo?: string;
  minAgeDays?: number;
  maxAgeDays?: number;
}

type DealStageWorkspaceRow = {
  id: string;
  deal_number: string;
  name: string;
  stage_id: string;
  workflow_route: WorkflowRoute;
  assigned_rep_id: string;
  assigned_rep_name: string;
  region_id: string | null;
  source: string | null;
  property_city: string | null;
  property_state: string | null;
  updated_at: string;
  stage_entered_at: string;
  awarded_amount: string | null;
  bid_estimate: string | null;
  dd_estimate: string | null;
  days_in_stage: number;
};

export interface DealBidBoardOwnershipState {
  isOwned: boolean;
  sourceOfTruth: "crm" | "bid_board";
  handoffStageSlug: string;
  downstreamStagesReadOnly: boolean;
  canEditInCrm: readonly string[];
  mirroredInCrm: readonly string[];
  reason: string;
  message: string;
}

/**
 * Validate that the assigned user exists, is active, and has access to the office.
 */
async function validateAssignee(tenantDb: TenantDb, assigneeId: string, officeId?: string): Promise<void> {
  const [user] = await tenantDb.select().from(users)
    .where(and(eq(users.id, assigneeId), eq(users.isActive, true))).limit(1);
  if (!user) throw new AppError(400, "Assigned user not found or inactive");
  if (officeId && user.officeId !== officeId) {
    const [access] = await tenantDb.select().from(userOfficeAccess)
      .where(and(eq(userOfficeAccess.userId, assigneeId), eq(userOfficeAccess.officeId, officeId))).limit(1);
    if (!access) throw new AppError(400, "Assigned user does not have access to this office");
  }
}

export function workflowFamilyForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

const SHARED_CANONICAL_DEAL_STAGE_SLUGS = new Set([
  // opportunity is standard_deal-family but valid for service deals as the
  // CRM-side RFP approval trigger before Bid Board-owned progression.
  "opportunity",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
]);

function isServiceRouteStandardFamilyStage(stage: PipelineStageRow | null | undefined) {
  return (
    stage?.workflowFamily === "standard_deal" &&
    SHARED_CANONICAL_DEAL_STAGE_SLUGS.has(stage.slug)
  );
}

async function getStageByIdForWorkflowRoute(stageId: string, workflowRoute: WorkflowRoute) {
  const stage = await getStageById(stageId, workflowFamilyForRoute(workflowRoute));
  if (stage) return stage;

  if (workflowRoute !== "service") return null;

  const standardStage = await getStageById(stageId, "standard_deal");
  return isServiceRouteStandardFamilyStage(standardStage) ? standardStage : null;
}

async function listDealStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .where(inArray(pipelineStageConfig.workflowFamily, ["standard_deal", "service_deal"]))
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

function buildDealWorkspaceScope(input: DealBoardInput | DealStagePageInput) {
  const filters = [
    sql`d.is_active = true`,
    sql`u.office_id = ${input.activeOfficeId}`,
  ];

  if (input.scope === "mine") {
    filters.push(sql`d.assigned_rep_id = ${input.userId}`);
  }

  return sql.join(filters, sql` and `);
}

function mapDealStageWorkspaceRow(row: DealStageWorkspaceRow) {
  return {
    id: row.id,
    dealNumber: row.deal_number,
    name: row.name,
    stageId: row.stage_id,
    workflowRoute: row.workflow_route,
    assignedRepId: row.assigned_rep_id,
    assignedRepName: row.assigned_rep_name,
    regionId: row.region_id,
    source: row.source,
    propertyCity: row.property_city,
    propertyState: row.property_state,
    updatedAt: row.updated_at,
    stageEnteredAt: row.stage_entered_at,
    daysInStage: Number(row.days_in_stage ?? 0),
    awardedAmount: row.awarded_amount,
    bidEstimate: row.bid_estimate,
    ddEstimate: row.dd_estimate,
  };
}

export function buildBidBoardOwnershipState(
  deal: Pick<typeof deals.$inferSelect, "isBidBoardOwned" | "workflowRoute">
): DealBidBoardOwnershipState {
  const isOwned = deal.isBidBoardOwned;

  return {
    isOwned,
    sourceOfTruth: isOwned ? "bid_board" : "crm",
    handoffStageSlug: estimatingBoundaryStageSlugForRoute(deal.workflowRoute),
    downstreamStagesReadOnly: isOwned,
    canEditInCrm: BID_BOARD_CRM_EDITABLE_FIELDS,
    mirroredInCrm: BID_BOARD_MIRRORED_FIELDS,
    reason: isOwned
      ? "Bid Board now owns downstream progression after the deal entered estimating."
      : "CRM still owns manual stage progression before estimating handoff.",
    message: isOwned
      ? "Bid Board is now the source of truth once this deal entered estimating."
      : "CRM remains the source of truth until the deal is handed off into estimating.",
  };
}

export async function getEstimatingBoundaryStage(workflowRoute: WorkflowRoute) {
  const workflowFamily = workflowFamilyForRoute(workflowRoute);
  const canonicalBoundarySlug = estimatingBoundaryStageSlugForRoute(workflowRoute);

  return (
    (await getStageBySlug(canonicalBoundarySlug, workflowFamily)) ??
    (await getStageBySlug("estimating", workflowFamily))
  );
}

export async function getRequiredEstimatingBoundaryStage(workflowRoute: WorkflowRoute) {
  const boundaryStage = await getEstimatingBoundaryStage(workflowRoute);
  if (!boundaryStage) {
    throw new AppError(
      500,
      BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE,
      "BID_BOARD_BOUNDARY_STAGE_MISSING"
    );
  }

  return boundaryStage;
}

export function isBidBoardOwnedDownstreamStage(
  targetStage: { slug: string; displayOrder: number; isTerminal: boolean },
  estimatingBoundary: { displayOrder: number } | null,
  workflowRoute: WorkflowRoute
) {
  if (
    targetStage.slug === "estimating" ||
    targetStage.slug === estimatingBoundaryStageSlugForRoute(workflowRoute)
  ) {
    return false;
  }

  return (
    Boolean(estimatingBoundary) &&
    targetStage.displayOrder > (estimatingBoundary?.displayOrder ?? Number.POSITIVE_INFINITY)
  );
}

async function validateDealPrimaryContact(
  tenantDb: TenantDb,
  companyId: string | null,
  primaryContactId?: string | null
) {
  if (!primaryContactId) {
    return;
  }

  if (!companyId) {
    throw new AppError(400, "Primary contact requires a company");
  }

  const [contact] = await tenantDb
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, primaryContactId), eq(contacts.isActive, true)))
    .limit(1);

  if (!contact) {
    throw new AppError(400, "Primary contact not found");
  }

  if (contact.companyId !== companyId) {
    throw new AppError(400, "Primary contact does not belong to the company");
  }
}

async function assertSourceLeadLineageAvailable(
  tenantDb: TenantDb,
  sourceLeadId: string,
  existingDealId?: string
) {
  const [existingDeal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.sourceLeadId, sourceLeadId))
    .limit(1);

  if (existingDeal && existingDeal.id !== existingDealId) {
    throw new AppError(409, "A deal already exists for this source lead");
  }
}

async function resolveSourceLeadLineage(
  tenantDb: TenantDb,
  input: CreateDealInput,
  options?: { existingDealId?: string }
) {
  if (!input.sourceLeadId) {
    return {
      companyId: input.companyId ?? null,
      propertyId: input.propertyId ?? null,
      primaryContactId: input.primaryContactId ?? null,
      sourceLeadId: null,
      source: input.source ?? null,
    };
  }

  await assertSourceLeadLineageAvailable(tenantDb, input.sourceLeadId, options?.existingDealId);

  const [sourceLead] = await tenantDb
    .select()
    .from(leads)
    .where(eq(leads.id, input.sourceLeadId))
    .limit(1);

  if (!sourceLead) {
    throw new AppError(400, "Source lead not found");
  }

  if (input.companyId && input.companyId !== sourceLead.companyId) {
    throw new AppError(400, "companyId does not match the source lead");
  }

  if (input.propertyId && input.propertyId !== sourceLead.propertyId) {
    throw new AppError(400, "propertyId does not match the source lead");
  }

  return {
    companyId: sourceLead.companyId,
    propertyId: sourceLead.propertyId,
    primaryContactId: input.primaryContactId ?? sourceLead.primaryContactId ?? null,
    sourceLeadId: sourceLead.id,
    source: input.source ?? sourceLead.source ?? null,
  };
}

/**
 * Get a paginated, filtered, sorted list of deals.
 */
export async function getDeals(tenantDb: TenantDb, filters: DealFilters, userRole: string, userId: string) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  // Build conditions array
  const conditions: any[] = [];

  // Active filter (default: true)
  const showActive = filters.isActive ?? true;
  conditions.push(eq(deals.isActive, showActive));

  // Reps only see their own deals
  if (userRole === "rep") {
    conditions.push(eq(deals.assignedRepId, userId));
  }

  // Filter by assigned rep (directors/admins filtering by rep)
  if (filters.assignedRepId) {
    conditions.push(eq(deals.assignedRepId, filters.assignedRepId));
  }

  // Filter by stage(s)
  if (filters.stageIds && filters.stageIds.length > 0) {
    conditions.push(inArray(deals.stageId, filters.stageIds));
  }

  // Filter by project type
  if (filters.projectTypeId) {
    conditions.push(eq(deals.projectTypeId, filters.projectTypeId));
  }

  // Filter by region
  if (filters.regionId) {
    conditions.push(eq(deals.regionId, filters.regionId));
  }

  // Filter by source
  if (filters.source) {
    conditions.push(eq(deals.source, filters.source));
  }

  // Inclusive signed-contract range. Used by the rep dashboard YTD/MTD
  // click-through to surface the deals contributing to each card.
  if (filters.contractSignedFrom) {
    conditions.push(sql`${contractSignedDateForReporting} >= ${filters.contractSignedFrom}::date`);
  }
  if (filters.contractSignedTo) {
    conditions.push(sql`${contractSignedDateForReporting} <= ${filters.contractSignedTo}::date`);
  }

  // Search across name, deal_number, description, property_address
  if (filters.search && filters.search.trim().length >= 2) {
    const searchTerm = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        ilike(deals.name, searchTerm),
        ilike(deals.dealNumber, searchTerm),
        ilike(deals.description, searchTerm),
        ilike(deals.propertyAddress, searchTerm)
      )
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Sort
  const sortColumn = (() => {
    switch (filters.sortBy) {
      case "name": return deals.name;
      case "created_at": return deals.createdAt;
      case "awarded_amount": return deals.awardedAmount;
      case "stage_entered_at": return deals.stageEnteredAt;
      case "expected_close_date": return deals.expectedCloseDate;
      case "contract_signed_date": return contractSignedDateForReporting;
      default: return deals.updatedAt;
    }
  })();
  const sortOrder = filters.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  // Execute count + data queries
  const [countResult, dealRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(deals).where(where),
    tenantDb
      .select()
      .from(deals)
      .where(where)
      .orderBy(sortOrder)
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    deals: dealRows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single deal by ID.
 */
export async function getDealById(tenantDb: TenantDb, dealId: string, userRole: string, userId: string) {
  const result = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  const deal = result[0] ?? null;
  if (!deal) return null;

  // Reps can only see their own deals
  if (userRole === "rep" && deal.assignedRepId !== userId) {
    throw new AppError(403, "You can only view your own deals");
  }

  return deal;
}

/**
 * Get deal with related data for the detail page.
 * Fetches stage history, approvals, change orders in parallel.
 */
export async function getDealDetail(tenantDb: TenantDb, dealId: string, userRole: string, userId: string) {
  const deal = await getDealById(tenantDb, dealId, userRole, userId);
  if (!deal) return null;

  const currentStage = await getStageByIdForWorkflowRoute(deal.stageId, deal.workflowRoute);

  const [stageHistory, approvals, cos] = await Promise.all([
    tenantDb
      .select()
      .from(dealStageHistory)
      .where(eq(dealStageHistory.dealId, dealId))
      .orderBy(desc(dealStageHistory.createdAt)),
    tenantDb
      .select()
      .from(dealApprovals)
      .where(eq(dealApprovals.dealId, dealId))
      .orderBy(desc(dealApprovals.createdAt)),
    tenantDb
      .select()
      .from(changeOrders)
      .where(eq(changeOrders.dealId, dealId))
      .orderBy(asc(changeOrders.coNumber)),
  ]);

  return {
    ...deal,
    postConversionEnrichment: evaluatePostConversionEnrichment(deal as any, currentStage ?? { isTerminal: true }),
    bidBoardOwnership: buildBidBoardOwnershipState(deal),
    stageHistory,
    approvals,
    changeOrders: cos,
  };
}

/**
 * Create a new deal.
 */
export async function createDeal(tenantDb: TenantDb, input: CreateDealInput) {
  const workflowRoute = input.workflowRoute ?? "normal";
  const stage = await getStageByIdForWorkflowRoute(input.stageId, workflowRoute);
  if (!stage) {
    throw new AppError(400, "Invalid stage ID for workflow route");
  }

  // Terminal stages cannot be initial stage
  if (stage.isTerminal) {
    throw new AppError(400, "Cannot create a deal in a terminal stage");
  }

  if (!input.migrationMode && !input.sourceLeadId) {
    throw new AppError(400, "sourceLeadId is required unless migrationMode is true");
  }

  if (
    input.sourceLeadId &&
    !input.migrationMode &&
    input.sourceLeadWriteMode !== "lead_conversion"
  ) {
    throw new AppError(400, "Use the lead conversion endpoint to create deals from leads");
  }

  const lineage = await resolveSourceLeadLineage(tenantDb, input);

  if (!input.migrationMode && (!lineage.companyId || !lineage.propertyId || !lineage.sourceLeadId)) {
    throw new AppError(
      400,
      "Deals require source lead lineage, company, and property unless migrationMode is true"
    );
  }

  // Validate the assigned rep exists, is active, and has office access
  await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
  await validateDealPrimaryContact(tenantDb, lineage.companyId, lineage.primaryContactId);

  const officeCode = assertValidOfficeCode(input.officeCode);
  const projectType = input.projectType ? await assertValidProjectType(input.projectType) : null;
  const createdAt = new Date();
  const dealNumber = await generateDealNumberForProject(tenantDb, {
    id: "new",
    officeCode,
    projectType,
    workflowRoute,
    createdAt,
  });

  const result = await tenantDb
    .insert(deals)
    .values({
      dealNumber,
      name: input.name,
      stageId: input.stageId,
      assignedRepId: input.assignedRepId,
      primaryContactId: lineage.primaryContactId,
      companyId: lineage.companyId,
      propertyId: lineage.propertyId,
      sourceLeadId: lineage.sourceLeadId,
      ddEstimate: input.ddEstimate ?? null,
      bidEstimate: input.bidEstimate ?? null,
      awardedAmount: input.awardedAmount ?? null,
      description: input.description ?? null,
      propertyAddress: input.propertyAddress ?? null,
      propertyCity: input.propertyCity ?? null,
      propertyState: input.propertyState ?? null,
      propertyZip: input.propertyZip ?? null,
      officeCode,
      projectType,
      projectTypeId: input.projectTypeId ?? null,
      regionId: input.regionId ?? null,
      source: lineage.source,
      winProbability: input.winProbability ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
      workflowRoute,
      createdAt,
      updatedAt: createdAt,
    })
    .returning();

  const newDeal = result[0];

  // Queue geocode as background job (the tenantDb connection will be released after commit)
  const { propertyAddress, propertyCity, propertyState, propertyZip, officeId } = input;
  if (propertyAddress) {
    db.insert(jobQueue).values({
      jobType: "geocode_deal",
      payload: { dealId: newDeal.id, address: `${propertyAddress}, ${propertyCity || ""} ${propertyState || ""} ${propertyZip || ""}`.trim() },
      officeId: officeId ?? null,
      status: "pending",
      runAfter: new Date(),
    }).catch((err) => console.error("[Deals] Failed to queue geocode job:", err));
  }

  if (input.actorUserId) {
    await createAssignmentTaskIfNeeded(tenantDb, {
      entityType: "deal",
      entityId: newDeal.id,
      entityName: newDeal.name,
      previousAssignedRepId: null,
      nextAssignedRepId: newDeal.assignedRepId,
      actorUserId: input.actorUserId,
      officeId: input.officeId ?? null,
    });
  }

  return newDeal;
}

/**
 * Update an existing deal (field edits, not stage changes).
 */
export async function updateDeal(
  tenantDb: TenantDb,
  dealId: string,
  input: UpdateDealInput,
  userRole: string,
  userId: string,
  officeId?: string,
) {
  // Verify deal exists and user has access
  const existing = await getDealById(tenantDb, dealId, userRole, userId);
  if (!existing) {
    throw new AppError(404, "Deal not found");
  }

  // Reps can only edit their own deals
  if (userRole === "rep" && existing.assignedRepId !== userId) {
    throw new AppError(403, "You can only edit your own deals");
  }

  // Validate assignee if being changed
  if (input.assignedRepId !== undefined) {
    await validateAssignee(tenantDb, input.assignedRepId, officeId);
  }

  if (input.sourceLeadId === null) {
    throw new AppError(400, "sourceLeadId cannot be cleared once set");
  }

  if (input.companyId === null || input.propertyId === null) {
    throw new AppError(400, "companyId and propertyId cannot be cleared once set");
  }

  if (!existing.sourceLeadId && input.migrationMode !== true) {
    throw new AppError(
      400,
      "Legacy deals require migrationMode=true until source lead lineage is backfilled"
    );
  }

  if (
    existing.sourceLeadId &&
    input.sourceLeadId !== undefined &&
    input.sourceLeadId !== existing.sourceLeadId
  ) {
    throw new AppError(400, "sourceLeadId is immutable once established");
  }

  if (
    existing.companyId &&
    input.companyId !== undefined &&
    input.companyId !== existing.companyId
  ) {
    throw new AppError(400, "companyId is immutable once established");
  }

  if (
    existing.propertyId &&
    input.propertyId !== undefined &&
    input.propertyId !== existing.propertyId
  ) {
    throw new AppError(400, "propertyId is immutable once established");
  }

  // Build update object — only include fields that are provided
  const updates: Record<string, any> = {};
  const projectTypeChange =
    input.projectType !== undefined
      ? {
          oldValue: existing.projectType ?? null,
          newValue: input.projectType === null ? null : await assertValidProjectType(input.projectType),
        }
      : null;

  if (projectTypeChange) {
    if (projectTypeChange.newValue === null) {
      throw new AppError(400, "projectType cannot be cleared after Opportunity");
    }
    if (projectTypeChange.newValue !== projectTypeChange.oldValue) {
      Object.assign(
        updates,
        await applyProjectTypeChange(
          tenantDb,
          existing,
          existing.projectTypeId ?? null,
          { id: userId, role: userRole },
          { projectTypeValue: projectTypeChange.newValue }
        )
      );
    }
  }

  if (input.name !== undefined) updates.name = input.name;
  const assignedRepChanged =
    input.assignedRepId !== undefined && input.assignedRepId !== existing.assignedRepId;
  if (input.assignedRepId !== undefined) {
    updates.assignedRepId = input.assignedRepId;
    if (assignedRepChanged) {
      updates.ownershipSyncStatus = "manual_reassign";
      updates.unassignedReasonCode = null;
    }
  }
  if (input.primaryContactId !== undefined) updates.primaryContactId = input.primaryContactId;
  if (input.ddEstimate !== undefined) updates.ddEstimate = input.ddEstimate;
  if (input.bidEstimate !== undefined) updates.bidEstimate = input.bidEstimate;
  if (input.awardedAmount !== undefined) updates.awardedAmount = input.awardedAmount;
  if (input.description !== undefined) updates.description = input.description;
  if (input.propertyAddress !== undefined) updates.propertyAddress = input.propertyAddress;
  if (input.propertyCity !== undefined) updates.propertyCity = input.propertyCity;
  if (input.propertyState !== undefined) updates.propertyState = input.propertyState;
  if (input.propertyZip !== undefined) updates.propertyZip = input.propertyZip;
  if (input.projectTypeId !== undefined) updates.projectTypeId = input.projectTypeId;
  if (input.regionId !== undefined) updates.regionId = input.regionId;
  if (input.source !== undefined) updates.source = input.source;
  if (input.winProbability !== undefined) updates.winProbability = input.winProbability;
  if (input.expectedCloseDate !== undefined) updates.expectedCloseDate = input.expectedCloseDate;
  if (input.proposalNotes !== undefined) updates.proposalNotes = input.proposalNotes;
  if (input.workflowRoute !== undefined) {
    if (existing.sourceLeadId) {
      throw new AppError(
        400,
        "workflowRoute is derived from lead routing and cannot be changed manually"
      );
    }
    const stage = await getStageByIdForWorkflowRoute(existing.stageId, input.workflowRoute);
    if (!stage) {
      throw new AppError(400, "Current stage is not valid for the requested workflow route");
    }
    updates.workflowRoute = input.workflowRoute;
  }

  if (input.sourceLeadId !== undefined) {
    const assignedRepId = input.assignedRepId ?? existing.assignedRepId;
    if (!assignedRepId) {
      throw new AppError(400, "assignedRepId is required when attaching a source lead");
    }
    const lineage = await resolveSourceLeadLineage(tenantDb, {
      name: existing.name,
      stageId: existing.stageId,
      assignedRepId,
      officeId,
      officeCode: existing.officeCode ?? "dfw",
      sourceLeadId: input.sourceLeadId,
      companyId: input.companyId ?? existing.companyId ?? undefined,
      propertyId: input.propertyId ?? existing.propertyId ?? undefined,
      primaryContactId:
        input.primaryContactId === undefined
          ? (existing.primaryContactId ?? undefined)
          : (input.primaryContactId ?? undefined),
      source: input.source === undefined ? (existing.source ?? undefined) : (input.source ?? undefined),
      workflowRoute: input.workflowRoute ?? existing.workflowRoute,
    }, {
      existingDealId: existing.id,
    });

    updates.sourceLeadId = lineage.sourceLeadId;
    if (!existing.companyId || input.companyId !== undefined) updates.companyId = lineage.companyId;
    if (!existing.propertyId || input.propertyId !== undefined) updates.propertyId = lineage.propertyId;
    if (input.primaryContactId === undefined && lineage.primaryContactId !== existing.primaryContactId) {
      updates.primaryContactId = lineage.primaryContactId;
    }
    if (input.source === undefined && lineage.source !== existing.source) {
      updates.source = lineage.source;
    }
  } else {
    if (input.companyId !== undefined) updates.companyId = input.companyId;
    if (input.propertyId !== undefined) updates.propertyId = input.propertyId;
  }

  if (
    input.primaryContactId !== undefined ||
    input.companyId !== undefined ||
    input.sourceLeadId !== undefined
  ) {
    await validateDealPrimaryContact(
      tenantDb,
      (updates.companyId ?? existing.companyId ?? null) as string | null,
      (updates.primaryContactId ?? existing.primaryContactId ?? null) as string | null
    );
  }

  if (existing.isBidBoardOwned) {
    for (const [field, label] of Object.entries(BID_BOARD_OWNED_UPDATE_FIELD_LABELS) as Array<
      [keyof UpdateDealInput, string]
    >) {
      if (input[field] !== undefined) {
        const message =
          field === "estimatingSubstage"
            ? "Estimating progress is mirrored from Bid Board after estimating handoff."
            : field === "proposalStatus"
              ? "Proposal status is mirrored from Bid Board after estimating handoff."
              : `${label} is mirrored from Bid Board after estimating handoff.`;
      throw new AppError(
        403,
          message,
        "BID_BOARD_OWNED_FIELD_READ_ONLY"
      );
      }
    }
  }

  // Validate and set estimating substage
  if (input.estimatingSubstage !== undefined) {
    if (
      input.estimatingSubstage !== null &&
      !VALID_ESTIMATING_SUBSTAGE_SET.has(input.estimatingSubstage)
    ) {
      throw new AppError(400, `Invalid estimating substage: ${input.estimatingSubstage}`);
    }
    updates.estimatingSubstage = input.estimatingSubstage;
  }

  // Proposal status with validation, state machine enforcement, auto-timestamps, and revision counter
  if (input.proposalStatus !== undefined) {
    if (
      input.proposalStatus !== null &&
      !VALID_PROPOSAL_STATUS_SET.has(input.proposalStatus)
    ) {
      throw new AppError(400, `Invalid proposal status: ${input.proposalStatus}`);
    }

    // Enforce valid state transitions
    const ALLOWED_TRANSITIONS: Record<string, string[]> = {
      not_started: ["drafting"],
      drafting: ["sent"],
      sent: ["under_review", "rejected"],
      under_review: ["revision_requested", "accepted", "rejected"],
      revision_requested: ["sent"],
      accepted: ["signed"],
      signed: [],
      rejected: [],
    };

    const currentStatus = existing.proposalStatus ?? "not_started";
    if (input.proposalStatus !== null) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(input.proposalStatus)) {
        throw new AppError(400, `Cannot transition proposal from '${currentStatus}' to '${input.proposalStatus}'`);
      }
    }

    updates.proposalStatus = input.proposalStatus;
    if (input.proposalStatus === "sent") {
      updates.proposalSentAt = new Date();
    } else if (input.proposalStatus === "revision_requested") {
      updates.proposalRevisionCount = sql`coalesce(proposal_revision_count, 0) + 1`;
    } else if (input.proposalStatus === "accepted" || input.proposalStatus === "signed") {
      updates.proposalAcceptedAt = new Date();
    }
  }

  if (Object.keys(updates).length === 0) {
    return existing;
  }

  const result = await tenantDb
    .update(deals)
    .set(updates)
    .where(eq(deals.id, dealId))
    .returning();

  const updatedDeal = result[0];

  if (assignedRepChanged && updatedDeal) {
    const changedAt = new Date();
    await writeAuditLog(tenantDb, {
      tableName: "deal_history",
      recordId: dealId,
      action: "update",
      changedBy: userId,
      changes: {
        assignedRepId: {
          from: existing.assignedRepId,
          to: input.assignedRepId ?? null,
        },
      },
      fullRow: {
        oldRepId: existing.assignedRepId,
        newRepId: input.assignedRepId ?? null,
        changedBy: userId,
        changedAt: changedAt.toISOString(),
      },
    });

    await createAssignmentTaskIfNeeded(tenantDb, {
      entityType: "deal",
      entityId: dealId,
      entityName: updatedDeal.name,
      previousAssignedRepId: existing.assignedRepId ?? null,
      nextAssignedRepId: input.assignedRepId ?? null,
      actorUserId: userId,
      officeId: officeId ?? null,
      now: changedAt,
    });

    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "deal.assignment.changed",
        dealId,
        dealName: updatedDeal.name,
        dealNumber: updatedDeal.dealNumber,
        oldRepId: existing.assignedRepId ?? null,
        newRepId: input.assignedRepId ?? null,
        changedBy: userId,
        changedAt: changedAt.toISOString(),
        source: "crm_deal_card",
        propagationChannel: "synchub_bid_board",
      },
      officeId: officeId ?? null,
      status: "pending",
      runAfter: changedAt,
    });
  }

  // Re-geocode if address changed
  const addressChanged =
    input.propertyAddress !== undefined ||
    input.propertyCity !== undefined ||
    input.propertyState !== undefined;

  if (addressChanged) {
    const addr = input.propertyAddress ?? existing.propertyAddress;
    const city = input.propertyCity ?? existing.propertyCity;
    const state = input.propertyState ?? existing.propertyState;
    const zip = input.propertyZip ?? existing.propertyZip;

    if (addr) {
      // Queue geocode as background job (the tenantDb connection will be released after commit)
      db.insert(jobQueue).values({
        jobType: "geocode_deal",
        payload: { dealId, address: `${addr}, ${city || ""} ${state || ""} ${zip || ""}`.trim() },
        officeId: officeId ?? null,
        status: "pending",
        runAfter: new Date(),
      }).catch((err) => console.error("[Deals] Failed to queue geocode job:", err));
    }
  }

  return updatedDeal;
}

export async function startProposalDraft(
  tenantDb: TenantDb,
  dealId: string,
  userRole: string,
  userId: string
) {
  const existing = await getDealById(tenantDb, dealId, userRole, userId);
  if (!existing) {
    throw new AppError(404, "Deal not found");
  }

  if (userRole === "rep" && existing.assignedRepId !== userId) {
    throw new AppError(403, "You can only edit your own deals");
  }

  if (existing.isBidBoardOwned) {
    throw new AppError(
      403,
      "Proposal status is mirrored from Bid Board after estimating handoff.",
      "BID_BOARD_OWNED_FIELD_READ_ONLY"
    );
  }

  const currentStatus = existing.proposalStatus ?? "not_started";
  if (currentStatus !== "not_started" && currentStatus !== "drafting") {
    throw new AppError(400, `Cannot start proposal draft from '${currentStatus}'`);
  }

  const startedAt = existing.proposalDraftStartedAt ?? new Date();
  const [updatedDeal] = await tenantDb
    .update(deals)
    .set({
      proposalStatus: "drafting",
      proposalDraftStartedAt: startedAt,
      updatedAt: new Date(),
    })
    .where(eq(deals.id, dealId))
    .returning();

  await writeAuditLog(tenantDb, {
    tableName: "proposal_drafts",
    recordId: dealId,
    action: "insert",
    changedBy: userId,
    changes: {
      proposalStatus: {
        from: existing.proposalStatus ?? "not_started",
        to: "drafting",
      },
      proposalDraftStartedAt: {
        from: existing.proposalDraftStartedAt ?? null,
        to: startedAt.toISOString(),
      },
    },
    fullRow: {
      dealId,
      status: "draft",
      startedAt: startedAt.toISOString(),
      createdBy: userId,
    },
  });

  return updatedDeal;
}

/**
 * Soft-delete a deal.
 * Only directors/admins can delete. Reps cannot.
 */
export async function deleteDeal(tenantDb: TenantDb, dealId: string, userRole: string) {
  if (userRole === "rep") {
    throw new AppError(403, "Only directors and admins can delete deals");
  }

  const result = await tenantDb
    .update(deals)
    .set({ isActive: false })
    .where(eq(deals.id, dealId))
    .returning();

  if (result.length === 0) {
    throw new AppError(404, "Deal not found");
  }

  // Auto-dismiss pending/in-progress tasks when deal is soft-deleted
  await tenantDb
    .update(tasks)
    .set({ status: "dismissed", isOverdue: false })
    .where(
      and(
        eq(tasks.dealId, dealId),
        inArray(tasks.status, ["pending", "in_progress"]),
      )
    );

  return result[0];
}

/**
 * Get deals grouped by stage for pipeline/kanban view.
 * Returns stages with their deals, ordered by display_order.
 * Excludes terminal stages from the main board (returned separately).
 */
export async function getDealsForPipeline(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  filters?: { assignedRepId?: string; includeDd?: boolean } & PipelineTerminalDateFilters
) {
  // Get all stages ordered
  const stages = await db
    .select()
    .from(pipelineStageConfig)
    .where(inArray(pipelineStageConfig.workflowFamily, ["standard_deal", "service_deal"]))
    .orderBy(asc(pipelineStageConfig.displayOrder));

  const terminalFilters = resolvePipelineTerminalDateFilters(filters);
  const wonStageIds = stages
    .filter((stage) => WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number]))
    .map((stage) => stage.id);
  const lostStageIds = stages
    .filter((stage) => LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number]))
    .map((stage) => stage.id);
  const canonicalWonStageId = stages.find((stage) => stage.slug === "won" && stage.isActivePipeline)?.id ?? null;
  const canonicalLostStageId = stages.find((stage) => stage.slug === "lost" && stage.isActivePipeline)?.id ?? null;
  const nonTerminalStageIds = stages.filter((stage) => !stage.isTerminal).map((stage) => stage.id);

  const sqlList = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);
  const terminalEnteredAt = (stageSlugs: readonly string[], fallback: unknown) => sql`
    COALESCE(
      (
        SELECT MAX(${dealStageHistory.createdAt})
        FROM ${dealStageHistory}
        JOIN ${pipelineStageConfig} terminal_history_stage
          ON terminal_history_stage.id = ${dealStageHistory.toStageId}
        WHERE ${dealStageHistory.dealId} = ${deals.id}
          AND terminal_history_stage.slug IN (${sqlList(stageSlugs)})
      ),
      ${fallback},
      ${deals.stageEnteredAt}
    )
  `;
  // Prefer the explicit stage-history entry timestamp. Older migrated rows may
  // only have terminal marker fields, so fall back to actual_close_date/lost_at
  // before using the current stage_entered_at value.
  const wonEnteredAt = terminalEnteredAt(WON_TERMINAL_STAGE_SLUGS, sql`${deals.actualCloseDate}::timestamptz`);
  const lostEnteredAt = terminalEnteredAt(LOST_TERMINAL_STAGE_SLUGS, deals.lostAt);

  // Non-terminal pipeline behavior remains active-only. Terminal stages are
  // date-filtered separately and intentionally include inactive historical rows.
  const visibilityConditions: any[] = [];
  if (nonTerminalStageIds.length > 0) {
    visibilityConditions.push(and(eq(deals.isActive, true), inArray(deals.stageId, nonTerminalStageIds)));
  }
  if (wonStageIds.length > 0) {
    const wonConditions = [
      inArray(deals.stageId, wonStageIds),
      sql`${wonEnteredAt} >= ${terminalFilters.won.since}`,
    ];
    if (terminalFilters.won.until) {
      wonConditions.push(sql`${wonEnteredAt} < ${addUtcDays(terminalFilters.won.until, 1)}`);
    }
    visibilityConditions.push(and(...wonConditions));
  }
  if (lostStageIds.length > 0) {
    const lostConditions = [
      inArray(deals.stageId, lostStageIds),
      sql`${lostEnteredAt} >= ${terminalFilters.lost.since}`,
    ];
    if (terminalFilters.lost.until) {
      lostConditions.push(sql`${lostEnteredAt} < ${addUtcDays(terminalFilters.lost.until, 1)}`);
    }
    visibilityConditions.push(and(...lostConditions));
  }

  // Build deal conditions
  const conditions: any[] = [or(...visibilityConditions)];

  // Reps see only their own deals
  if (userRole === "rep") {
    conditions.push(eq(deals.assignedRepId, userId));
  } else if (filters?.assignedRepId) {
    conditions.push(eq(deals.assignedRepId, filters.assignedRepId));
  }

  const allDeals = await tenantDb
    .select()
    .from(deals)
    .where(and(...conditions))
    .orderBy(desc(deals.updatedAt))
    .limit(500);

  // Group deals by stageId
  const dealsByStage = new Map<string, typeof allDeals>();
  for (const deal of allDeals) {
    const displayStageId =
      canonicalWonStageId && wonStageIds.includes(deal.stageId)
        ? canonicalWonStageId
        : canonicalLostStageId && lostStageIds.includes(deal.stageId)
          ? canonicalLostStageId
          : deal.stageId;
    const stageDeals = dealsByStage.get(displayStageId) ?? [];
    stageDeals.push(deal);
    dealsByStage.set(displayStageId, stageDeals);
  }

  // Build response: active pipeline stages + date-filtered terminal stages.
  const pipelineColumns = stages
    .filter((s) => (s.isTerminal ? s.isActivePipeline : filters?.includeDd || s.isActivePipeline)) // exclude DD unless toggled
    .map((stage) => ({
      stage,
      deals: dealsByStage.get(stage.id) ?? [],
      totalValue: (dealsByStage.get(stage.id) ?? []).reduce(
        (sum, d) => sum + Number(d.awardedAmount ?? d.bidEstimate ?? d.ddEstimate ?? 0),
        0
      ),
      count: (dealsByStage.get(stage.id) ?? []).length,
    }));

  const terminalStages = stages
    .filter((s) => s.isTerminal)
    .filter((s) => s.isActivePipeline)
    .map((stage) => ({
      stage,
      deals: dealsByStage.get(stage.id) ?? [],
      count: (dealsByStage.get(stage.id) ?? []).length,
      totalValue: (dealsByStage.get(stage.id) ?? []).reduce(
        (sum, d) => sum + Number(d.awardedAmount ?? d.bidEstimate ?? d.ddEstimate ?? 0),
        0
      ),
    }));

  return { pipelineColumns, terminalStages };
}

export async function listDealStagePage(tenantDb: TenantDb, input: DealStagePageInput) {
  const [stage] = await listDealStages().then((stages) => stages.filter((item) => item.id === input.stageId));
  if (!stage) throw new AppError(404, "Deal stage not found");

  const page = Math.max(1, input.page || 1);
  const pageSize = Math.max(1, Math.min(100, input.pageSize || 25));
  const offset = (page - 1) * pageSize;
  const scope = buildDealWorkspaceScope(input);

  const conditions = [
    scope,
    sql`d.stage_id = ${input.stageId}`,
  ];

  if (input.search?.trim()) {
    const searchTerm = `%${input.search.trim()}%`;
    conditions.push(sql`(d.name ilike ${searchTerm} or d.deal_number ilike ${searchTerm})`);
  }
  if (input.assignedRepId) {
    conditions.push(sql`d.assigned_rep_id = ${input.assignedRepId}`);
  }
  if (input.regionId) {
    conditions.push(sql`d.region_id = ${input.regionId}`);
  }
  if (input.workflowRoute === "normal" || input.workflowRoute === "service") {
    conditions.push(sql`d.workflow_route = ${input.workflowRoute}`);
  }
  if (input.updatedFrom) {
    conditions.push(sql`d.updated_at::date >= ${input.updatedFrom}::date`);
  }
  if (input.updatedTo) {
    conditions.push(sql`d.updated_at::date <= ${input.updatedTo}::date`);
  }
  if (typeof input.minAgeDays === "number" && Number.isFinite(input.minAgeDays)) {
    conditions.push(sql`extract(day from now() - d.stage_entered_at) >= ${input.minAgeDays}`);
  }
  if (typeof input.maxAgeDays === "number" && Number.isFinite(input.maxAgeDays)) {
    conditions.push(sql`extract(day from now() - d.stage_entered_at) <= ${input.maxAgeDays}`);
  }

  const where = sql.join(conditions, sql` and `);

  const countResult = await tenantDb.execute(sql`
    select
      count(*)::int as total,
      coalesce(sum(coalesce(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)), 0)::numeric as total_value,
      round(avg(extract(day from now() - d.stage_entered_at)))::int as average_days_in_stage
    from deals d
    join users u on u.id = d.assigned_rep_id
    where ${where}
  `);

  const rowResult = await tenantDb.execute(sql`
    select
      d.id,
      d.deal_number,
      d.name,
      d.stage_id,
      d.workflow_route,
      d.assigned_rep_id,
      u.display_name as assigned_rep_name,
      d.region_id,
      d.source,
      d.property_city,
      d.property_state,
      d.updated_at,
      d.stage_entered_at,
      d.awarded_amount,
      d.bid_estimate,
      d.dd_estimate,
      extract(day from now() - d.stage_entered_at)::int as days_in_stage
    from deals d
    join users u on u.id = d.assigned_rep_id
    where ${where}
    order by d.stage_entered_at asc, d.updated_at desc
    limit ${pageSize}
    offset ${offset}
  `);

  const summaryRow =
    (countResult.rows[0] as
      | { total?: string | number; total_value?: string | number; average_days_in_stage?: string | number | null }
      | undefined) ?? {};
  const total = Number(summaryRow.total ?? 0);

  return {
    stage,
    scope: input.scope,
    summary: {
      count: total,
      totalValue: Number(summaryRow.total_value ?? 0),
      averageDaysInStage:
        summaryRow.average_days_in_stage == null ? null : Number(summaryRow.average_days_in_stage),
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    rows: (rowResult.rows as DealStageWorkspaceRow[]).map(mapDealStageWorkspaceRow),
  };
}

/**
 * Get distinct sources used across deals (for filter dropdowns).
 */
export async function getDealSources(tenantDb: TenantDb) {
  const result = await tenantDb
    .selectDistinct({ source: deals.source })
    .from(deals)
    .where(not(isNull(deals.source)))
    .orderBy(asc(deals.source));

  return result.map((r) => r.source).filter(Boolean) as string[];
}

/**
 * Set or clear contract_signed_date on a deal. Writes an audit_log row when
 * the value actually changes. No-op (and no audit row) when the requested
 * value matches the current value.
 *
 * On a null→date transition (and ONLY then), also calculates the booked
 * commission for the assigned rep via calculateCommissionForDeal. The
 * deal update + audit insert + commission calculation all run inside a
 * single db.transaction() so a partial failure rolls back cleanly — a
 * deal can't be marked contract-signed without its commission row, and
 * the commission can't exist without the date.
 *
 * Caller is responsible for the RBAC gate. The route exposing this
 * function uses requireRole("admin", "director").
 */
export async function setDealContractSignedDate(
  tenantDb: TenantDb,
  dealId: string,
  contractSignedDate: string | null,
  userId: string,
  officeId: string | null = null
): Promise<typeof deals.$inferSelect | null> {
  return tenantDb.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1);
    if (!existing) return null;

    const oldValue = existing.contractSignedDate ?? null;
    const newValue = contractSignedDate ?? null;
    const oldContractSignedAt = normalizeContractSignedAt(existing.contractSignedAt);
    const newContractSignedAt = contractSignedAtFromDate(newValue);
    if (
      oldValue === newValue &&
      (oldValue !== null || timestampKey(oldContractSignedAt) === timestampKey(newContractSignedAt))
    ) {
      return existing;
    }

    const isInitialContractSignedAt =
      oldValue == null && oldContractSignedAt == null && newContractSignedAt != null;
    let contractStageId: string | null = null;
    if (isInitialContractSignedAt) {
      const currentStage = await getStageByIdForWorkflowRoute(
        existing.stageId,
        existing.workflowRoute ?? "normal"
      );
      if (currentStage?.slug !== "contract") {
        throw new AppError(
          400,
          "contract_signed_at can only be set while the deal is in Contract.",
          "CONTRACT_SIGNED_STAGE_REQUIRED"
        );
      }
      contractStageId = currentStage.id;
    }

    const now = new Date();
    const [updated] = await tx
      .update(deals)
      .set({
        contractSignedDate: newValue,
        contractSignedAt: newContractSignedAt,
        updatedAt: now,
      })
      .where(eq(deals.id, dealId))
      .returning();

    if (!updated) return null;

    await writeAuditLog(tx, {
      tableName: "deals",
      recordId: dealId,
      action: "update",
      changedBy: userId,
      changes: {
        contractSignedDate: { from: oldValue, to: newValue },
        contractSignedAt: {
          from: oldContractSignedAt ? oldContractSignedAt.toISOString() : null,
          to: newContractSignedAt ? newContractSignedAt.toISOString() : null,
        },
      },
    });

    // Commission fires only on null → date. Edits and clears do not
    // recalculate (per Decision 5; recalc-on-edit is a TODO follow-up).
    const isInitialSign = oldValue == null && newValue != null;
    if (isInitialSign) {
      await calculateCommissionForDeal(tx, {
        dealId,
        contractSignedDate: newValue,
        triggeredByUserId: userId,
      });
    }

    if (isInitialContractSignedAt && isContractSignedHandoffEnabled()) {
      const payload = {
        eventName: DOMAIN_EVENTS.DEAL_CONTRACT_SIGNED,
        eventId: randomUUID(),
        idempotencyKey: `deal:${dealId}:contract_signed:${newContractSignedAt.toISOString()}`,
        dealId,
        dealNumber: updated.dealNumber,
        dealName: updated.name,
        officeId,
        workflowRoute: updated.workflowRoute,
        contractSignedAt: newContractSignedAt,
        contractStageId: contractStageId ?? updated.stageId,
        signedBy: userId,
        source: "crm_contract_signed_date",
      } satisfies DealContractSignedEventPayload;

      await tx.insert(jobQueue).values({
        jobType: "domain_event",
        payload,
        officeId,
        status: "pending",
        runAfter: now,
      });
    }

    return updated;
  });
}

function contractSignedAtFromDate(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function normalizeContractSignedAt(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function timestampKey(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
