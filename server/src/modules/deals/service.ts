import { eq, and, desc, asc, ilike, inArray, sql, or, isNull, not } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  dealApprovals,
  changeOrders,
  pipelineStageConfig,
  contacts,
  leads,
  companies,
  properties,
  users,
  userOfficeAccess,
  tasks,
  jobQueue,
} from "@trock-crm/shared/schema";
import type { WorkflowRoute } from "@trock-crm/shared/types";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getStageById } from "../pipeline/service.js";
import { captureInitialForecastMilestone } from "../reports/forecast-milestones-service.js";
import { createAssignmentTaskIfNeeded } from "../assignment-tasks/service.js";
import { canCreateDealWithoutSourceLead } from "./direct-create-rules.js";

// Type alias for the tenant-scoped Drizzle instance
type TenantDb = NodePgDatabase<typeof schema>;

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
  sort?: string;
  assignedRepId?: string;
  staleOnly?: boolean;
  status?: string;
  workflowRoute?: string;
  source?: string;
}

type DealWorkspaceRow = {
  id: string;
  deal_number: string;
  name: string;
  stage_id: string;
  assigned_rep_id: string;
  office_id: string;
  workflow_route: string;
  awarded_amount: string | null;
  bid_estimate: string | null;
  dd_estimate: string | null;
  property_city: string | null;
  property_state: string | null;
  source: string | null;
  last_activity_at: string | null;
  stage_entered_at: string;
  updated_at: string;
};

export interface DealFilters {
  search?: string;
  stageIds?: string[];
  assignedRepId?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  isActive?: boolean;
  sortBy?: "name" | "created_at" | "updated_at" | "awarded_amount" | "stage_entered_at" | "expected_close_date";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface CreateDealInput {
  name: string;
  stageId: string;
  assignedRepId: string;
  actorUserId: string;
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
  projectTypeId?: string | null;
  regionId?: string | null;
  source?: string | null;
  winProbability?: number | null;
  expectedCloseDate?: string | null;
  decisionMakerName?: string | null;
  decisionProcess?: string | null;
  budgetStatus?: string | null;
  incumbentVendor?: string | null;
  unitCount?: number | null;
  buildYear?: number | null;
  forecastWindow?: "30_days" | "60_days" | "90_days" | "beyond_90" | "uncommitted" | null;
  forecastCategory?: "commit" | "best_case" | "pipeline" | null;
  forecastConfidencePercent?: number | null;
  forecastRevenue?: string | null;
  forecastGrossProfit?: string | null;
  forecastBlockers?: string | null;
  nextStep?: string | null;
  nextStepDueAt?: string | null;
  nextMilestoneAt?: string | null;
  supportNeededType?: "leadership" | "estimating" | "operations" | "executive_team" | null;
  supportNeededNotes?: string | null;
  proposalStatus?: string | null;
  proposalNotes?: string | null;
  estimatingSubstage?: string | null;
}

/**
 * Generate a sequential deal number: TR-{YYYY}-{NNNN}
 * Uses SELECT ... FOR UPDATE to lock the highest deal number row during the
 * transaction, preventing concurrent collisions from parallel inserts.
 */
async function generateDealNumber(tenantDb: TenantDb): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `TR-${year}-`;

  // Advisory lock on the year prefix to prevent concurrent collisions.
  // FOR UPDATE only locks existing rows — this also protects the empty-year case.
  await tenantDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`);

  // Lock the highest deal number row for this year using FOR UPDATE.
  // This prevents concurrent transactions from reading the same max value.
  const result = await tenantDb
    .select({ dealNumber: deals.dealNumber })
    .from(deals)
    .where(ilike(deals.dealNumber, `${prefix}%`))
    .orderBy(desc(deals.dealNumber))
    .limit(1)
    .for("update");

  let nextSeq = 1;
  if (result.length > 0) {
    const lastNum = result[0].dealNumber;
    const seqPart = lastNum.replace(prefix, "");
    const parsed = parseInt(seqPart, 10);
    if (!isNaN(parsed)) {
      nextSeq = parsed + 1;
    }
  }

  return `${prefix}${String(nextSeq).padStart(4, "0")}`;
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

  if (input.role === "rep" || input.scope === "mine") {
    filters.push(sql`d.assigned_rep_id = ${input.userId}`);
  }

  if ("assignedRepId" in input && input.assignedRepId) {
    filters.push(sql`d.assigned_rep_id = ${input.assignedRepId}`);
  }

  if ("source" in input && input.source) {
    filters.push(sql`d.source = ${input.source}`);
  }

  if ("workflowRoute" in input && input.workflowRoute) {
    filters.push(sql`d.workflow_route = ${input.workflowRoute}`);
  }

  if ("search" in input && input.search && input.search.trim().length >= 2) {
    const term = `%${input.search.trim()}%`;
    filters.push(sql`(d.name ilike ${term} or d.deal_number ilike ${term} or d.property_city ilike ${term} or d.property_state ilike ${term})`);
  }

  if ("staleOnly" in input && input.staleOnly) {
    filters.push(sql`d.last_activity_at is null or d.last_activity_at < now() - interval '14 days'`);
  }

  return sql.join(filters, sql` and `);
}

function normalizeDealStageSort(sort?: string) {
  switch (sort) {
    case "value_desc":
      return sql`coalesce(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0) desc, d.updated_at desc`;
    case "name_asc":
      return sql`d.name asc, d.updated_at desc`;
    case "age_desc":
      return sql`d.stage_entered_at asc, d.updated_at desc`;
    default:
      return sql`d.updated_at desc, d.name asc`;
  }
}

function mapDealWorkspaceRow(row: DealWorkspaceRow) {
  return {
    id: row.id,
    dealNumber: row.deal_number,
    name: row.name,
    stageId: row.stage_id,
    assignedRepId: row.assigned_rep_id,
    officeId: row.office_id,
    workflowRoute: row.workflow_route,
    awardedAmount: row.awarded_amount,
    bidEstimate: row.bid_estimate,
    ddEstimate: row.dd_estimate,
    propertyCity: row.property_city,
    propertyState: row.property_state,
    source: row.source,
    lastActivityAt: row.last_activity_at,
    stageEnteredAt: row.stage_entered_at,
    updatedAt: row.updated_at,
  };
}

function workflowFamilyForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
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

async function validateDealHierarchy(
  tenantDb: TenantDb,
  input: {
    companyId?: string | null;
    propertyId?: string | null;
    primaryContactId?: string | null;
  }
) {
  if (!input.companyId || !input.propertyId) {
    throw new AppError(400, "Company and property are required");
  }

  const [company] = await tenantDb
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, input.companyId), eq(companies.isActive, true)))
    .limit(1);

  if (!company) {
    throw new AppError(400, "Company not found");
  }

  const [property] = await tenantDb
    .select()
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.isActive, true)))
    .limit(1);

  if (!property) {
    throw new AppError(400, "Property not found");
  }

  if (property.companyId !== input.companyId) {
    throw new AppError(400, "Property does not belong to the company");
  }

  await validateDealPrimaryContact(tenantDb, input.companyId, input.primaryContactId);
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

async function resolveSourceLeadLineage<
  T extends {
    sourceLeadId?: string | null;
    companyId?: string | null;
    propertyId?: string | null;
    primaryContactId?: string | null;
    source?: string | null;
  },
>(
  tenantDb: TenantDb,
  input: T,
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
    stageHistory,
    approvals,
    changeOrders: cos,
  };
}

/**
 * Create a new deal.
 */
export async function createDeal(tenantDb: TenantDb, input: CreateDealInput) {
  const workflowRoute = input.workflowRoute ?? "estimating";
  const stage = await getStageById(input.stageId, workflowFamilyForRoute(workflowRoute));
  if (!stage) {
    throw new AppError(400, "Invalid stage ID for workflow route");
  }

  // Terminal stages cannot be initial stage
  if (stage.isTerminal) {
    throw new AppError(400, "Cannot create a deal in a terminal stage");
  }

  if (!canCreateDealWithoutSourceLead(input)) {
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

  const isDirectCreate = !input.sourceLeadId && !input.migrationMode;
  if (isDirectCreate) {
    await validateDealHierarchy(tenantDb, {
      companyId: lineage.companyId,
      propertyId: lineage.propertyId,
      primaryContactId: lineage.primaryContactId,
    });
  }

  if (!input.migrationMode && !isDirectCreate && (!lineage.companyId || !lineage.propertyId || !lineage.sourceLeadId)) {
    throw new AppError(
      400,
      "Deals require source lead lineage, company, and property unless migrationMode is true"
    );
  }

  // Validate the assigned rep exists, is active, and has office access
  await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
  if (!isDirectCreate) {
    await validateDealPrimaryContact(tenantDb, lineage.companyId, lineage.primaryContactId);
  }

  const dealNumber = await generateDealNumber(tenantDb);

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
      projectTypeId: input.projectTypeId ?? null,
      regionId: input.regionId ?? null,
      source: lineage.source,
      winProbability: input.winProbability ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
      workflowRoute,
    })
    .returning();

  const newDeal = result[0];

  await createAssignmentTaskIfNeeded(tenantDb, {
    entityType: "deal",
    entityId: newDeal.id,
    entityName: newDeal.name,
    previousAssignedRepId: null,
    nextAssignedRepId: newDeal.assignedRepId,
    actorUserId: input.actorUserId,
    officeId: input.officeId ?? null,
  });

  await captureInitialForecastMilestone(tenantDb, {
    deal: {
      id: newDeal.id,
      assignedRepId: newDeal.assignedRepId,
      workflowRoute: newDeal.workflowRoute,
      stageId: newDeal.stageId,
      expectedCloseDate: newDeal.expectedCloseDate,
      ddEstimate: newDeal.ddEstimate,
      bidEstimate: newDeal.bidEstimate,
      awardedAmount: newDeal.awardedAmount,
      source: newDeal.source,
    },
    userId: input.assignedRepId,
  });

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
  const nextAssignedRepId =
    input.assignedRepId !== undefined ? input.assignedRepId : existing.assignedRepId;
  if (input.name !== undefined) updates.name = input.name;
  if (input.assignedRepId !== undefined) updates.assignedRepId = input.assignedRepId;
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
  if (input.decisionMakerName !== undefined) updates.decisionMakerName = input.decisionMakerName;
  if (input.decisionProcess !== undefined) updates.decisionProcess = input.decisionProcess;
  if (input.budgetStatus !== undefined) updates.budgetStatus = input.budgetStatus;
  if (input.incumbentVendor !== undefined) updates.incumbentVendor = input.incumbentVendor;
  if (input.unitCount !== undefined) updates.unitCount = input.unitCount;
  if (input.buildYear !== undefined) updates.buildYear = input.buildYear;
  if (input.forecastWindow !== undefined) updates.forecastWindow = input.forecastWindow;
  if (input.forecastCategory !== undefined) updates.forecastCategory = input.forecastCategory;
  if (input.forecastConfidencePercent !== undefined) {
    updates.forecastConfidencePercent = input.forecastConfidencePercent;
  }
  if (input.forecastRevenue !== undefined) updates.forecastRevenue = input.forecastRevenue;
  if (input.forecastGrossProfit !== undefined) updates.forecastGrossProfit = input.forecastGrossProfit;
  if (input.forecastBlockers !== undefined) updates.forecastBlockers = input.forecastBlockers;
  if (input.nextStep !== undefined) updates.nextStep = input.nextStep;
  if (input.nextStepDueAt !== undefined) {
    updates.nextStepDueAt = input.nextStepDueAt ? new Date(input.nextStepDueAt) : null;
  }
  if (input.nextMilestoneAt !== undefined) {
    updates.nextMilestoneAt = input.nextMilestoneAt ? new Date(input.nextMilestoneAt) : null;
  }
  if (input.supportNeededType !== undefined) updates.supportNeededType = input.supportNeededType;
  if (input.supportNeededNotes !== undefined) updates.supportNeededNotes = input.supportNeededNotes;
  if (input.proposalNotes !== undefined) updates.proposalNotes = input.proposalNotes;
  if (input.workflowRoute !== undefined) {
    const stage = await getStageById(existing.stageId, workflowFamilyForRoute(input.workflowRoute));
    if (!stage) {
      throw new AppError(400, "Current stage is not valid for the requested workflow route");
    }
    updates.workflowRoute = input.workflowRoute;
  }

  if (input.sourceLeadId !== undefined) {
    const lineage = await resolveSourceLeadLineage(tenantDb, {
      name: existing.name,
      stageId: existing.stageId,
      assignedRepId: existing.assignedRepId,
      officeId,
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

  // Validate and set estimating substage
  if (input.estimatingSubstage !== undefined) {
    const VALID_SUBSTAGES = ["scope_review", "site_visit", "missing_info", "building_estimate", "under_review", "sent_to_client"];
    if (input.estimatingSubstage !== null && !VALID_SUBSTAGES.includes(input.estimatingSubstage)) {
      throw new AppError(400, `Invalid estimating substage: ${input.estimatingSubstage}`);
    }
    updates.estimatingSubstage = input.estimatingSubstage;
  }

  // Proposal status with validation, state machine enforcement, auto-timestamps, and revision counter
  if (input.proposalStatus !== undefined) {
    const VALID_STATUSES = ["not_started", "drafting", "sent", "under_review", "revision_requested", "accepted", "signed", "rejected"];
    if (input.proposalStatus !== null && !VALID_STATUSES.includes(input.proposalStatus)) {
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

  if (
    input.forecastWindow !== undefined ||
    input.forecastCategory !== undefined ||
    input.forecastConfidencePercent !== undefined ||
    input.forecastRevenue !== undefined ||
    input.forecastGrossProfit !== undefined ||
    input.forecastBlockers !== undefined ||
    input.nextMilestoneAt !== undefined
  ) {
    updates.forecastUpdatedAt = new Date();
    updates.forecastUpdatedBy = userId;
  }

  const result = await tenantDb
    .update(deals)
    .set(updates)
    .where(eq(deals.id, dealId))
    .returning();

  if (
    input.assignedRepId !== undefined &&
    input.assignedRepId !== existing.assignedRepId
  ) {
    await createAssignmentTaskIfNeeded(tenantDb, {
      entityType: "deal",
      entityId: result[0].id,
      entityName: result[0].name,
      previousAssignedRepId: existing.assignedRepId,
      nextAssignedRepId,
      actorUserId: userId,
      officeId: officeId ?? null,
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

  return result[0];
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
  filters?: { assignedRepId?: string; includeDd?: boolean }
) {
  // Get all stages ordered
  const stages = await db
    .select()
    .from(pipelineStageConfig)
    .where(inArray(pipelineStageConfig.workflowFamily, ["standard_deal", "service_deal"]))
    .orderBy(asc(pipelineStageConfig.displayOrder));

  // Build deal conditions
  const conditions: any[] = [eq(deals.isActive, true)];

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
    const stageDeals = dealsByStage.get(deal.stageId) ?? [];
    stageDeals.push(deal);
    dealsByStage.set(deal.stageId, stageDeals);
  }

  // Build response: active pipeline stages + terminal stages separately
  const pipelineColumns = stages
    .filter((s) => !s.isTerminal)
    .filter((s) => filters?.includeDd || s.isActivePipeline) // exclude DD unless toggled
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
    .map((stage) => ({
      stage,
      deals: dealsByStage.get(stage.id) ?? [],
      count: (dealsByStage.get(stage.id) ?? []).length,
    }));

  return { pipelineColumns, terminalStages };
}

export async function listDealBoard(tenantDb: TenantDb, input: DealBoardInput) {
  const stages = await listDealStages();
  const rowResult = await tenantDb.execute(sql`
    select
      d.id,
      d.deal_number,
      d.name,
      d.stage_id,
      d.assigned_rep_id,
      u.office_id,
      d.workflow_route,
      d.awarded_amount,
      d.bid_estimate,
      d.dd_estimate,
      d.property_city,
      d.property_state,
      d.source,
      d.last_activity_at,
      d.stage_entered_at,
      d.updated_at
    from deals d
    join users u on u.id = d.assigned_rep_id
    where ${buildDealWorkspaceScope(input)}
    order by d.updated_at desc
  `);

  const rows = rowResult.rows as DealWorkspaceRow[];
  const pipelineColumns = stages
    .filter((stage) => !stage.isTerminal)
    .filter((stage) => input.includeDd || stage.isActivePipeline)
    .map((stage) => {
      const dealsForStage = rows
        .filter((row) => row.stage_id === stage.id)
        .map(mapDealWorkspaceRow);

      return {
        stage,
        deals: dealsForStage,
        totalValue: dealsForStage.reduce(
          (sum, deal) => sum + Number(deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate ?? 0),
          0
        ),
        count: dealsForStage.length,
      };
    });

  const terminalStages = stages
    .filter((stage) => stage.isTerminal)
    .map((stage) => {
      const dealsForStage = rows
        .filter((row) => row.stage_id === stage.id)
        .map(mapDealWorkspaceRow);

      return {
        stage,
        deals: dealsForStage,
        count: dealsForStage.length,
      };
    });

  return {
    pipelineColumns,
    terminalStages,
    columns: pipelineColumns,
  };
}

export async function listDealStagePage(tenantDb: TenantDb, input: DealStagePageInput) {
  const [stage] = await listDealStages().then((stages) => stages.filter((item) => item.id === input.stageId));
  if (!stage) {
    throw new AppError(404, "Deal stage not found");
  }

  const page = Math.max(1, input.page || 1);
  const pageSize = Math.max(1, Math.min(100, input.pageSize || 25));
  const offset = (page - 1) * pageSize;
  const scope = buildDealWorkspaceScope(input);
  const countResult = await tenantDb.execute(sql`
    select
      count(*)::int as total,
      coalesce(sum(coalesce(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0)), 0)::numeric as total_value
    from deals d
    join users u on u.id = d.assigned_rep_id
    where ${scope} and d.stage_id = ${input.stageId}
  `);
  const rowResult = await tenantDb.execute(sql`
    select
      d.id,
      d.deal_number,
      d.name,
      d.stage_id,
      d.assigned_rep_id,
      u.office_id,
      d.workflow_route,
      d.awarded_amount,
      d.bid_estimate,
      d.dd_estimate,
      d.property_city,
      d.property_state,
      d.source,
      d.last_activity_at,
      d.stage_entered_at,
      d.updated_at
    from deals d
    join users u on u.id = d.assigned_rep_id
    where ${scope} and d.stage_id = ${input.stageId}
    order by ${normalizeDealStageSort(input.sort)}
    limit ${pageSize}
    offset ${offset}
  `);

  const summaryRow = (countResult.rows[0] as { total?: string | number; total_value?: string | number } | undefined) ?? {};
  const total = Number(summaryRow.total ?? 0);

  return {
    stage,
    scope: input.scope,
    summary: {
      count: total,
      totalValue: Number(summaryRow.total_value ?? 0),
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    rows: (rowResult.rows as DealWorkspaceRow[]).map(mapDealWorkspaceRow),
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
