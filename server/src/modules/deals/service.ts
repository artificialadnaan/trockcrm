import { eq, and, desc, asc, ilike, inArray, sql, or, isNull, not } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  dealApprovals,
  changeOrders,
  pipelineStageConfig,
  users,
  userOfficeAccess,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

// Type alias for the tenant-scoped Drizzle instance
type TenantDb = NodePgDatabase<typeof schema>;

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
  // Validate stage exists
  const stage = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.id, input.stageId))
    .limit(1);
  if (stage.length === 0) {
    throw new AppError(400, "Invalid stage ID");
  }

  // Terminal stages cannot be initial stage
  if (stage[0].isTerminal) {
    throw new AppError(400, "Cannot create a deal in a terminal stage");
  }

  // Validate the assigned rep exists, is active, and has office access
  await validateAssignee(tenantDb, input.assignedRepId);

  const dealNumber = await generateDealNumber(tenantDb);

  const result = await tenantDb
    .insert(deals)
    .values({
      dealNumber,
      name: input.name,
      stageId: input.stageId,
      assignedRepId: input.assignedRepId,
      primaryContactId: input.primaryContactId ?? null,
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
      source: input.source ?? null,
      winProbability: input.winProbability ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
    })
    .returning();

  return result[0];
}

/**
 * Update an existing deal (field edits, not stage changes).
 */
export async function updateDeal(
  tenantDb: TenantDb,
  dealId: string,
  input: UpdateDealInput,
  userRole: string,
  userId: string
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
    await validateAssignee(tenantDb, input.assignedRepId);
  }

  // Build update object — only include fields that are provided
  const updates: Record<string, any> = {};
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

  if (Object.keys(updates).length === 0) {
    return existing;
  }

  const result = await tenantDb
    .update(deals)
    .set(updates)
    .where(eq(deals.id, dealId))
    .returning();

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
    .orderBy(desc(deals.updatedAt));

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
