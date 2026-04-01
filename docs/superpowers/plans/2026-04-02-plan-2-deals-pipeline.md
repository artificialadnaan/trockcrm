# Plan 2: Deals & Pipeline Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full deal lifecycle management: CRUD, stage gate validation, pipeline kanban, stage change enforcement (backward prevention, closed lost/won handling, director overrides, deal reopen), multi-estimate display, and stale deal detection. This delivers the core business value of the CRM -- pipeline visibility and deal progression tracking.

**Architecture:** Server-side deal service + stage gate validation service mounted on the tenant router. Worker job for stale deal scanning. React frontend with list view, detail page (tabbed), pipeline kanban (drag-and-drop), and deal forms with stage change modals.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, React, Vite, Tailwind CSS, shadcn/ui, lucide-react, @dnd-kit (drag-and-drop), Recharts

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md` -- Sections 4.2 (deals table), 5 (RBAC), 6 (Stage Gate Validation), 10 (Reporting), 11 (Frontend), 15 (Edge Cases)

**Depends On:** Plan 1 (Foundation) -- fully implemented

---

## File Structure

```
server/src/modules/deals/
  ├── routes.ts               # /api/deals/* route definitions
  ├── service.ts              # Deal CRUD operations
  ├── stage-gate.ts           # Stage gate validation logic
  └── stage-change.ts         # Stage transition orchestration

server/src/modules/pipeline/
  ├── routes.ts               # /api/pipeline/* route definitions (config lookups)
  └── service.ts              # Pipeline stage config queries

server/tests/modules/deals/
  ├── service.test.ts         # Deal CRUD unit tests
  ├── stage-gate.test.ts      # Stage gate validation unit tests
  ├── stage-change.test.ts    # Stage change logic unit tests
  └── routes.test.ts          # API integration tests

worker/src/jobs/
  └── stale-deals.ts          # Stale deal scanner cron job

client/src/pages/
  ├── deals/
  │   ├── deal-list-page.tsx        # Filterable/sortable deal list
  │   ├── deal-detail-page.tsx      # Tabbed detail view (overview, files, email, timeline, history)
  │   └── deal-new-page.tsx         # New deal creation page
  └── pipeline/
      └── pipeline-page.tsx         # Kanban board

client/src/components/deals/
  ├── deal-form.tsx                 # Create/edit form (shared between new + edit)
  ├── deal-card.tsx                 # Card for kanban + list views
  ├── deal-overview-tab.tsx         # Overview tab content
  ├── deal-timeline-tab.tsx         # Activity timeline tab
  ├── deal-history-tab.tsx          # Stage history tab
  ├── deal-estimates-card.tsx       # Multi-estimate display
  ├── deal-stage-badge.tsx          # Colored stage badge
  ├── deal-filters.tsx              # Filter bar for list view
  ├── stage-change-dialog.tsx       # Stage advancement confirmation
  ├── lost-deal-modal.tsx           # Closed Lost required fields modal
  ├── won-deal-modal.tsx            # Closed Won confirmation
  ├── backward-move-dialog.tsx      # Director override for backward moves
  └── stage-gate-checklist.tsx      # Shows missing requirements

client/src/hooks/
  ├── use-deals.ts                  # Deal data fetching + mutations
  ├── use-pipeline-config.ts        # Pipeline stage config fetching
  └── use-deal-filters.ts           # Filter state management with localStorage persistence

client/src/lib/
  └── deal-utils.ts                 # Formatting, computed values, stage helpers
```

---

## Task 1: Deal Service + API Routes (CRUD)

- [ ] Create `server/src/modules/deals/service.ts`
- [ ] Create `server/src/modules/deals/routes.ts`
- [ ] Create `server/src/modules/pipeline/service.ts`
- [ ] Create `server/src/modules/pipeline/routes.ts`
- [ ] Mount routes in `server/src/app.ts`

### 1a. Pipeline Config Service

**File: `server/src/modules/pipeline/service.ts`**

```typescript
import { eq, asc } from "drizzle-orm";
import {
  pipelineStageConfig,
  lostDealReasons,
  projectTypeConfig,
  regionConfig,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";

export async function getAllStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

export async function getStageById(id: string) {
  const result = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.id, id))
    .limit(1);
  return result[0] ?? null;
}

export async function getStageBySlug(slug: string) {
  const result = await db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.slug, slug))
    .limit(1);
  return result[0] ?? null;
}

export async function getActiveLostReasons() {
  return db
    .select()
    .from(lostDealReasons)
    .where(eq(lostDealReasons.isActive, true))
    .orderBy(asc(lostDealReasons.displayOrder));
}

export async function getActiveProjectTypes() {
  return db
    .select()
    .from(projectTypeConfig)
    .where(eq(projectTypeConfig.isActive, true))
    .orderBy(asc(projectTypeConfig.displayOrder));
}

export async function getActiveRegions() {
  return db
    .select()
    .from(regionConfig)
    .where(eq(regionConfig.isActive, true))
    .orderBy(asc(regionConfig.displayOrder));
}
```

### 1b. Pipeline Config Routes

**File: `server/src/modules/pipeline/routes.ts`**

```typescript
import { Router } from "express";
import {
  getAllStages,
  getActiveLostReasons,
  getActiveProjectTypes,
  getActiveRegions,
} from "./service.js";

const router = Router();

// GET /api/pipeline/stages — all pipeline stages (ordered)
router.get("/stages", async (_req, res, next) => {
  try {
    const stages = await getAllStages();
    res.json({ stages });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/lost-reasons — active lost deal reasons
router.get("/lost-reasons", async (_req, res, next) => {
  try {
    const reasons = await getActiveLostReasons();
    res.json({ reasons });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/project-types — active project types (hierarchical)
router.get("/project-types", async (_req, res, next) => {
  try {
    const types = await getActiveProjectTypes();
    res.json({ projectTypes: types });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/regions — active regions
router.get("/regions", async (_req, res, next) => {
  try {
    const regions = await getActiveRegions();
    res.json({ regions });
  } catch (err) {
    next(err);
  }
});

export const pipelineRoutes = router;
```

### 1c. Deal Service

**File: `server/src/modules/deals/service.ts`**

```typescript
import { eq, and, desc, asc, ilike, inArray, sql, or, isNull, not } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  dealApprovals,
  changeOrders,
  pipelineStageConfig,
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
 * Uses a raw query to get the next number atomically within the transaction.
 */
async function generateDealNumber(tenantDb: TenantDb): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `TR-${year}-`;

  // Find the highest existing deal number for this year
  const result = await tenantDb
    .select({ dealNumber: deals.dealNumber })
    .from(deals)
    .where(ilike(deals.dealNumber, `${prefix}%`))
    .orderBy(desc(deals.dealNumber))
    .limit(1);

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
```

### 1d. Deal Routes

**File: `server/src/modules/deals/routes.ts`**

```typescript
import { Router } from "express";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getDeals,
  getDealById,
  getDealDetail,
  createDeal,
  updateDeal,
  deleteDeal,
  getDealsForPipeline,
  getDealSources,
} from "./service.js";
import { changeDealStage } from "./stage-change.js";

const router = Router();

// GET /api/deals — list deals (paginated, filtered, sorted)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      stageIds: req.query.stageIds
        ? (req.query.stageIds as string).split(",")
        : undefined,
      assignedRepId: req.query.assignedRepId as string | undefined,
      projectTypeId: req.query.projectTypeId as string | undefined,
      regionId: req.query.regionId as string | undefined,
      source: req.query.source as string | undefined,
      isActive: req.query.isActive === "false" ? false : true,
      sortBy: req.query.sortBy as any,
      sortDir: req.query.sortDir as "asc" | "desc" | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getDeals(req.tenantDb!, filters, req.user!.role, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/sources — distinct deal sources for filter dropdown
router.get("/sources", async (req, res, next) => {
  try {
    const sources = await getDealSources(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ sources });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/pipeline — deals grouped by stage for kanban
router.get("/pipeline", async (req, res, next) => {
  try {
    const filters = {
      assignedRepId: req.query.assignedRepId as string | undefined,
      includeDd: req.query.includeDd === "true",
    };
    const result = await getDealsForPipeline(
      req.tenantDb!,
      req.user!.role,
      req.user!.id,
      filters
    );
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id — single deal (basic)
router.get("/:id", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    await req.commitTransaction!();
    res.json({ deal });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/detail — deal with stage history, approvals, change orders
router.get("/:id/detail", async (req, res, next) => {
  try {
    const detail = await getDealDetail(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!detail) throw new AppError(404, "Deal not found");
    await req.commitTransaction!();
    res.json({ deal: detail });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals — create a new deal
router.post("/", async (req, res, next) => {
  try {
    const { name, stageId, assignedRepId, ...rest } = req.body;
    if (!name || !stageId) {
      throw new AppError(400, "Name and stageId are required");
    }
    // Default assigned rep to current user if not provided
    const repId = assignedRepId || req.user!.id;

    const deal = await createDeal(req.tenantDb!, {
      name,
      stageId,
      assignedRepId: repId,
      ...rest,
    });
    await req.commitTransaction!();
    res.status(201).json({ deal });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id — update deal fields (not stage)
router.patch("/:id", async (req, res, next) => {
  try {
    const deal = await updateDeal(
      req.tenantDb!,
      req.params.id,
      req.body,
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ deal });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/stage — change deal stage (with validation)
router.post("/:id/stage", async (req, res, next) => {
  try {
    const { targetStageId, overrideReason, lostReasonId, lostNotes, lostCompetitor } = req.body;
    if (!targetStageId) {
      throw new AppError(400, "targetStageId is required");
    }

    const result = await changeDealStage(req.tenantDb!, {
      dealId: req.params.id,
      targetStageId,
      userId: req.user!.id,
      userRole: req.user!.role,
      overrideReason,
      lostReasonId,
      lostNotes,
      lostCompetitor,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id — soft-delete (director/admin only)
router.delete("/:id", requireRole("admin", "director"), async (req, res, next) => {
  try {
    await deleteDeal(req.tenantDb!, req.params.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const dealRoutes = router;
```

### 1e. Mount Routes in App

**File: `server/src/app.ts`** -- Add to the tenantRouter section:

Add these imports at the top of the file:
```typescript
import { dealRoutes } from "./modules/deals/routes.js";
import { pipelineRoutes } from "./modules/pipeline/routes.js";
```

Mount on the tenantRouter, before the `app.use("/api", authMiddleware, tenantMiddleware, tenantRouter)` line:
```typescript
  tenantRouter.use("/deals", dealRoutes);
  tenantRouter.use("/pipeline", pipelineRoutes);
```

The pipeline routes don't technically need tenant context (they query public schema), but mounting them under the tenant router keeps the auth middleware consistent. The queries use the global `db` instance, not `req.tenantDb`.

---

## Task 2: Stage Gate Validation Service

- [ ] Create `server/src/modules/deals/stage-gate.ts`

This is the core enforcement logic referenced by the spec in Section 6.

**File: `server/src/modules/deals/stage-gate.ts`**

```typescript
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  pipelineStageConfig,
  deals,
  dealApprovals,
  files,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import type { UserRole } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export interface StageGateResult {
  allowed: boolean;
  isBackwardMove: boolean;
  isTerminal: boolean;
  targetStage: {
    id: string;
    name: string;
    slug: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  currentStage: {
    id: string;
    name: string;
    slug: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  missingRequirements: {
    fields: string[];
    documents: string[];
    approvals: string[];
  };
  requiresOverride: boolean;
  overrideType: "backward_move" | "missing_requirements" | null;
  blockReason: string | null;
}

/**
 * Validate whether a deal can move to the target stage.
 *
 * Returns a full picture of what's required, what's missing, and whether
 * the move is allowed for the given user role. Does NOT mutate any data.
 */
export async function validateStageGate(
  tenantDb: TenantDb,
  dealId: string,
  targetStageId: string,
  userRole: UserRole
): Promise<StageGateResult> {
  // Fetch current deal
  const dealResult = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (dealResult.length === 0) {
    throw new Error("Deal not found");
  }
  const deal = dealResult[0];

  // Fetch current stage and target stage from public config
  const [currentStageResult, targetStageResult] = await Promise.all([
    db.select().from(pipelineStageConfig).where(eq(pipelineStageConfig.id, deal.stageId)).limit(1),
    db.select().from(pipelineStageConfig).where(eq(pipelineStageConfig.id, targetStageId)).limit(1),
  ]);

  if (currentStageResult.length === 0) {
    throw new Error("Current stage config not found");
  }
  if (targetStageResult.length === 0) {
    throw new Error("Target stage config not found");
  }

  const currentStage = currentStageResult[0];
  const targetStage = targetStageResult[0];

  // Same stage -- no-op
  if (currentStage.id === targetStage.id) {
    return {
      allowed: true,
      isBackwardMove: false,
      isTerminal: targetStage.isTerminal,
      targetStage: {
        id: targetStage.id,
        name: targetStage.name,
        slug: targetStage.slug,
        isTerminal: targetStage.isTerminal,
        displayOrder: targetStage.displayOrder,
      },
      currentStage: {
        id: currentStage.id,
        name: currentStage.name,
        slug: currentStage.slug,
        isTerminal: currentStage.isTerminal,
        displayOrder: currentStage.displayOrder,
      },
      missingRequirements: { fields: [], documents: [], approvals: [] },
      requiresOverride: false,
      overrideType: null,
      blockReason: null,
    };
  }

  // Detect backward move
  const isBackwardMove = targetStage.displayOrder < currentStage.displayOrder;

  // Check required fields on the deal
  const requiredFields = (targetStage.requiredFields as string[]) ?? [];
  const missingFields: string[] = [];
  for (const field of requiredFields) {
    const value = (deal as any)[field];
    if (value == null || value === "") {
      missingFields.push(field);
    }
  }

  // Check required documents (file categories that must exist for this deal)
  const requiredDocuments = (targetStage.requiredDocuments as string[]) ?? [];
  const missingDocuments: string[] = [];
  if (requiredDocuments.length > 0) {
    // Query files for this deal by category
    const existingFiles = await tenantDb
      .select({ category: files.category })
      .from(files)
      .where(and(eq(files.dealId, dealId), eq(files.isActive, true)));

    const existingCategories = new Set(existingFiles.map((f) => f.category));
    for (const docType of requiredDocuments) {
      if (!existingCategories.has(docType as any)) {
        missingDocuments.push(docType);
      }
    }
  }

  // Check required approvals
  const requiredApprovals = (targetStage.requiredApprovals as string[]) ?? [];
  const missingApprovals: string[] = [];
  if (requiredApprovals.length > 0) {
    const existingApprovals = await tenantDb
      .select()
      .from(dealApprovals)
      .where(
        and(
          eq(dealApprovals.dealId, dealId),
          eq(dealApprovals.targetStageId, targetStageId),
          eq(dealApprovals.status, "approved")
        )
      );

    const approvedRoles = new Set(existingApprovals.map((a) => a.requiredRole));
    for (const role of requiredApprovals) {
      if (!approvedRoles.has(role as any)) {
        missingApprovals.push(role);
      }
    }
  }

  const hasMissingRequirements =
    missingFields.length > 0 || missingDocuments.length > 0 || missingApprovals.length > 0;

  const isDirectorOrAdmin = userRole === "director" || userRole === "admin";

  // Determine if the move is allowed
  let allowed = true;
  let blockReason: string | null = null;
  let requiresOverride = false;
  let overrideType: "backward_move" | "missing_requirements" | null = null;

  // Rule 1: Backward move -- blocked for reps, director can override
  if (isBackwardMove) {
    if (!isDirectorOrAdmin) {
      allowed = false;
      blockReason = "Reps cannot move deals backward. A director must perform this action.";
    } else {
      requiresOverride = true;
      overrideType = "backward_move";
    }
  }

  // Rule 2: Missing requirements -- blocked for reps, director can override
  if (hasMissingRequirements) {
    if (!isDirectorOrAdmin) {
      allowed = false;
      blockReason = blockReason
        ? `${blockReason} Additionally, stage requirements are not met.`
        : "Stage requirements are not met. Complete all required items before advancing.";
    } else {
      requiresOverride = true;
      overrideType = overrideType ?? "missing_requirements";
    }
  }

  return {
    allowed,
    isBackwardMove,
    isTerminal: targetStage.isTerminal,
    targetStage: {
      id: targetStage.id,
      name: targetStage.name,
      slug: targetStage.slug,
      isTerminal: targetStage.isTerminal,
      displayOrder: targetStage.displayOrder,
    },
    currentStage: {
      id: currentStage.id,
      name: currentStage.name,
      slug: currentStage.slug,
      isTerminal: currentStage.isTerminal,
      displayOrder: currentStage.displayOrder,
    },
    missingRequirements: {
      fields: missingFields,
      documents: missingDocuments,
      approvals: missingApprovals,
    },
    requiresOverride,
    overrideType,
    blockReason,
  };
}

/**
 * Check a stage gate without committing -- used by the frontend to show
 * the requirements checklist before the user confirms.
 */
export async function preflightStageCheck(
  tenantDb: TenantDb,
  dealId: string,
  targetStageId: string,
  userRole: UserRole
): Promise<StageGateResult> {
  return validateStageGate(tenantDb, dealId, targetStageId, userRole);
}
```

---

## Task 3: Deal Stage Change API (with Validation, Backward Prevention, Lost/Won Handling)

- [ ] Create `server/src/modules/deals/stage-change.ts`

This is the orchestration layer that calls the gate validator, applies the mutation, handles terminal stage logic (Closed Won/Lost), emits domain events, and records stage history.

**File: `server/src/modules/deals/stage-change.ts`**

```typescript
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealStageHistory,
  pipelineStageConfig,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "../../events/types.js";
import { validateStageGate } from "./stage-gate.js";
import type { UserRole } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export interface StageChangeInput {
  dealId: string;
  targetStageId: string;
  userId: string;
  userRole: UserRole;
  overrideReason?: string;
  lostReasonId?: string;
  lostNotes?: string;
  lostCompetitor?: string;
}

export interface StageChangeResult {
  deal: typeof deals.$inferSelect;
  stageHistory: typeof dealStageHistory.$inferSelect;
  eventsEmitted: string[];
}

/**
 * Change a deal's stage with full validation, enforcement, and event emission.
 *
 * Orchestration flow:
 * 1. Validate stage gate requirements
 * 2. Enforce backward move rules
 * 3. Handle terminal stage requirements (Closed Lost, Closed Won)
 * 4. Handle deal reopen (moving from terminal back to active)
 * 5. Update deal record
 * 6. Insert stage history record (PG trigger also fires, but we insert
 *    explicitly here to include override_reason and is_director_override
 *    which the trigger cannot know about)
 * 7. Emit domain events
 */
export async function changeDealStage(
  tenantDb: TenantDb,
  input: StageChangeInput
): Promise<StageChangeResult> {
  const { dealId, targetStageId, userId, userRole, overrideReason, lostReasonId, lostNotes, lostCompetitor } = input;

  // Step 1: Validate stage gate
  const gateResult = await validateStageGate(tenantDb, dealId, targetStageId, userRole);

  // Step 2: Enforce rules
  if (!gateResult.allowed) {
    throw new AppError(403, gateResult.blockReason ?? "Stage change not allowed");
  }

  // If override is required, must provide reason
  if (gateResult.requiresOverride && !overrideReason) {
    throw new AppError(400, "Override reason is required for this stage change", "OVERRIDE_REQUIRED");
  }

  const isDirectorOrAdmin = userRole === "director" || userRole === "admin";
  const isDirectorOverride = gateResult.requiresOverride && isDirectorOrAdmin;

  // Step 3: Terminal stage enforcement
  const targetStage = gateResult.targetStage;

  // Closed Lost: require lost_reason_id + lost_notes
  if (targetStage.slug === "closed_lost") {
    if (!lostReasonId) {
      throw new AppError(400, "lost_reason_id is required when closing a deal as lost");
    }
    if (!lostNotes || lostNotes.trim().length === 0) {
      throw new AppError(400, "lost_notes is required when closing a deal as lost");
    }
  }

  // Step 4: Handle reopen (moving from terminal to active)
  const currentStage = gateResult.currentStage;
  const isReopen = currentStage.isTerminal && !targetStage.isTerminal;

  // Fetch existing deal for duration calculation
  const existingDeal = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (existingDeal.length === 0) {
    throw new AppError(404, "Deal not found");
  }
  const deal = existingDeal[0];

  // Step 5: Build deal update
  const dealUpdates: Record<string, any> = {
    stageId: targetStageId,
    stageEnteredAt: new Date(),
  };

  // Closed Won handling
  if (targetStage.slug === "closed_won") {
    dealUpdates.actualCloseDate = new Date().toISOString().split("T")[0]; // DATE only
  }

  // Closed Lost handling
  if (targetStage.slug === "closed_lost") {
    dealUpdates.lostReasonId = lostReasonId;
    dealUpdates.lostNotes = lostNotes;
    dealUpdates.lostCompetitor = lostCompetitor ?? null;
    dealUpdates.lostAt = new Date();
  }

  // Reopen handling: clear terminal-stage fields
  if (isReopen) {
    dealUpdates.actualCloseDate = null;
    dealUpdates.lostReasonId = null;
    dealUpdates.lostNotes = null;
    dealUpdates.lostCompetitor = null;
    dealUpdates.lostAt = null;
  }

  // Apply update
  const updatedDealResult = await tenantDb
    .update(deals)
    .set(dealUpdates)
    .where(eq(deals.id, dealId))
    .returning();
  const updatedDeal = updatedDealResult[0];

  // Step 6: Insert stage history record
  // Note: The PG trigger on deals.stage_id also fires and inserts a record,
  // but that trigger-based record won't have override_reason or is_director_override.
  // We handle this by: the trigger records the basic move, and we insert a separate
  // explicit record with the override metadata.
  //
  // IMPORTANT: To avoid duplicate history records, the PG trigger should be the
  // sole writer. However, the trigger can't know about override_reason and
  // is_director_override (application-level context). Two options:
  //
  // Option A: Disable trigger, always insert from application code.
  // Option B: Trigger inserts basic record, application code UPDATEs the latest
  //           record to add override metadata.
  //
  // We use Option B: let the trigger fire, then update the most recent history
  // record for this deal with the override context.
  //
  // Actually, the safest approach: since the trigger fires AFTER UPDATE on stage_id
  // and we're in the same transaction, the trigger has already fired by this point.
  // We find the most recent history record and update it.

  // Calculate duration in previous stage
  const durationInPreviousStage = deal.stageEnteredAt
    ? `${Math.floor((Date.now() - new Date(deal.stageEnteredAt).getTime()) / 1000)} seconds`
    : null;

  // Update the trigger-inserted history record with override context
  // Find the record just inserted by the trigger (most recent for this deal)
  const latestHistory = await tenantDb
    .select()
    .from(dealStageHistory)
    .where(eq(dealStageHistory.dealId, dealId))
    .orderBy(eq(dealStageHistory.createdAt, dealStageHistory.createdAt)) // newest first
    .limit(1);

  // Use raw SQL for the ORDER BY DESC since Drizzle's orderBy with desc needs import
  const historyUpdateResult = await tenantDb.execute(
    `UPDATE deal_stage_history
     SET is_backward_move = $1,
         is_director_override = $2,
         override_reason = $3,
         changed_by = $4,
         duration_in_previous_stage = $5::interval
     WHERE id = (
       SELECT id FROM deal_stage_history
       WHERE deal_id = $6
       ORDER BY created_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [
      gateResult.isBackwardMove,
      isDirectorOverride,
      isDirectorOverride ? overrideReason : null,
      userId,
      durationInPreviousStage,
      dealId,
    ] as any
  );

  // Step 7: Emit domain events
  const eventsEmitted: string[] = [];

  // Get the officeId from the request context -- we need it for events
  // Since we're called from the route handler, we pass officeId through
  // For now, we use deal data + userId + a placeholder officeId that the
  // route handler will supply via a wrapper. We'll emit events after commit
  // in the route handler instead. Actually, let's return the events to emit
  // and let the route handler emit them after commit.

  const eventsToEmit: Array<{ name: string; payload: any }> = [];

  // Always emit stage changed
  eventsToEmit.push({
    name: DOMAIN_EVENTS.DEAL_STAGE_CHANGED,
    payload: {
      dealId,
      dealName: updatedDeal.name,
      dealNumber: updatedDeal.dealNumber,
      fromStageId: currentStage.id,
      fromStageName: currentStage.name,
      toStageId: targetStage.id,
      toStageName: targetStage.name,
      isBackwardMove: gateResult.isBackwardMove,
      isDirectorOverride,
      changedBy: userId,
    },
  });
  eventsEmitted.push(DOMAIN_EVENTS.DEAL_STAGE_CHANGED);

  // Closed Won
  if (targetStage.slug === "closed_won") {
    eventsToEmit.push({
      name: DOMAIN_EVENTS.DEAL_WON,
      payload: {
        dealId,
        dealName: updatedDeal.name,
        dealNumber: updatedDeal.dealNumber,
        awardedAmount: updatedDeal.awardedAmount,
        assignedRepId: updatedDeal.assignedRepId,
      },
    });
    eventsEmitted.push(DOMAIN_EVENTS.DEAL_WON);
  }

  // Closed Lost
  if (targetStage.slug === "closed_lost") {
    eventsToEmit.push({
      name: DOMAIN_EVENTS.DEAL_LOST,
      payload: {
        dealId,
        dealName: updatedDeal.name,
        dealNumber: updatedDeal.dealNumber,
        lostReasonId,
        lostNotes,
        lostCompetitor,
        assignedRepId: updatedDeal.assignedRepId,
      },
    });
    eventsEmitted.push(DOMAIN_EVENTS.DEAL_LOST);
  }

  // NOTE: Events should be emitted AFTER the transaction commits.
  // The route handler calls req.commitTransaction() and then emits.
  // We store the events on a temporary property for the route to pick up.
  // Better pattern: return them and let the route handle emission.

  return {
    deal: updatedDeal,
    stageHistory: (historyUpdateResult as any).rows?.[0] ?? null,
    eventsEmitted,
    _eventsToEmit: eventsToEmit, // internal: route handler uses this
  } as any;
}
```

### 3b. Update Deal Routes to Emit Events After Commit

Update the stage change route in `server/src/modules/deals/routes.ts` to emit events after transaction commit:

```typescript
// POST /api/deals/:id/stage — change deal stage (with validation)
router.post("/:id/stage", async (req, res, next) => {
  try {
    const { targetStageId, overrideReason, lostReasonId, lostNotes, lostCompetitor } = req.body;
    if (!targetStageId) {
      throw new AppError(400, "targetStageId is required");
    }

    const result = await changeDealStage(req.tenantDb!, {
      dealId: req.params.id,
      targetStageId,
      userId: req.user!.id,
      userRole: req.user!.role,
      overrideReason,
      lostReasonId,
      lostNotes,
      lostCompetitor,
    });

    await req.commitTransaction!();

    // Emit events AFTER successful commit
    const eventsToEmit = (result as any)._eventsToEmit ?? [];
    for (const event of eventsToEmit) {
      try {
        await eventBus.emitAll({
          name: event.name,
          payload: event.payload,
          officeId: req.user!.activeOfficeId ?? req.user!.officeId,
          userId: req.user!.id,
          timestamp: new Date(),
        });
      } catch (eventErr) {
        // Log but don't fail the response -- events are best-effort after commit
        console.error(`[Deals] Failed to emit event ${event.name}:`, eventErr);
      }
    }

    res.json({
      deal: result.deal,
      stageHistory: result.stageHistory,
      eventsEmitted: result.eventsEmitted,
    });
  } catch (err) {
    next(err);
  }
});
```

### 3c. Add Preflight Stage Check Route

Add to `server/src/modules/deals/routes.ts`:

```typescript
// POST /api/deals/:id/stage/preflight — check stage gate without committing
router.post("/:id/stage/preflight", async (req, res, next) => {
  try {
    const { targetStageId } = req.body;
    if (!targetStageId) {
      throw new AppError(400, "targetStageId is required");
    }

    const result = await preflightStageCheck(
      req.tenantDb!,
      req.params.id,
      targetStageId,
      req.user!.role
    );

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

Add the import at the top of routes.ts:
```typescript
import { preflightStageCheck } from "./stage-gate.js";
```

---

## Task 4: Deal API Tests

- [ ] Create `server/tests/modules/deals/service.test.ts`
- [ ] Create `server/tests/modules/deals/stage-gate.test.ts`
- [ ] Create `server/tests/modules/deals/routes.test.ts`

### 4a. Deal Service Tests

**File: `server/tests/modules/deals/service.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool } from "../../src/db.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import {
  createDeal,
  getDealById,
  getDeals,
  updateDeal,
  deleteDeal,
  getDealsForPipeline,
} from "../../src/modules/deals/service.js";

// These tests require a running PostgreSQL with the test schema provisioned.
// Run: DATABASE_URL=postgres://... npx vitest run server/tests/modules/deals/

let client: any;
let tenantDb: ReturnType<typeof drizzle>;
let ddStageId: string;
let estimatingStageId: string;
let closedWonStageId: string;
let closedLostStageId: string;
let testUserId: string;

describe("Deal Service", () => {
  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = 'office_dallas', 'public'");

    tenantDb = drizzle(client, { schema });

    // Fetch stage IDs from seed data
    const stages = await client.query("SELECT id, slug FROM public.pipeline_stage_config");
    for (const row of stages.rows) {
      if (row.slug === "dd") ddStageId = row.id;
      if (row.slug === "estimating") estimatingStageId = row.id;
      if (row.slug === "closed_won") closedWonStageId = row.id;
      if (row.slug === "closed_lost") closedLostStageId = row.id;
    }

    // Fetch a test user
    const users = await client.query("SELECT id FROM public.users WHERE role = 'rep' LIMIT 1");
    testUserId = users.rows[0].id;
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  describe("createDeal", () => {
    it("should create a deal with auto-generated deal number", async () => {
      const deal = await createDeal(tenantDb, {
        name: "Test Office Building",
        stageId: ddStageId,
        assignedRepId: testUserId,
      });

      expect(deal).toBeDefined();
      expect(deal.dealNumber).toMatch(/^TR-\d{4}-\d{4}$/);
      expect(deal.name).toBe("Test Office Building");
      expect(deal.stageId).toBe(ddStageId);
      expect(deal.isActive).toBe(true);
    });

    it("should reject creation in a terminal stage", async () => {
      await expect(
        createDeal(tenantDb, {
          name: "Bad Deal",
          stageId: closedWonStageId,
          assignedRepId: testUserId,
        })
      ).rejects.toThrow("Cannot create a deal in a terminal stage");
    });

    it("should store estimate values", async () => {
      const deal = await createDeal(tenantDb, {
        name: "Estimate Test",
        stageId: ddStageId,
        assignedRepId: testUserId,
        ddEstimate: "150000.00",
        bidEstimate: "175000.00",
        awardedAmount: "180000.00",
      });

      expect(deal.ddEstimate).toBe("150000.00");
      expect(deal.bidEstimate).toBe("175000.00");
      expect(deal.awardedAmount).toBe("180000.00");
    });
  });

  describe("getDeals", () => {
    it("should return paginated results", async () => {
      // Create a few deals first
      await createDeal(tenantDb, { name: "Deal A", stageId: ddStageId, assignedRepId: testUserId });
      await createDeal(tenantDb, { name: "Deal B", stageId: ddStageId, assignedRepId: testUserId });

      const result = await getDeals(tenantDb, { page: 1, limit: 10 }, "admin", testUserId);
      expect(result.deals.length).toBeGreaterThan(0);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.total).toBeGreaterThan(0);
    });

    it("should filter by search term", async () => {
      await createDeal(tenantDb, { name: "Unique Search Target XYZ", stageId: ddStageId, assignedRepId: testUserId });

      const result = await getDeals(tenantDb, { search: "Unique Search Target" }, "admin", testUserId);
      expect(result.deals.some((d) => d.name === "Unique Search Target XYZ")).toBe(true);
    });

    it("reps should only see their own deals", async () => {
      const result = await getDeals(tenantDb, {}, "rep", testUserId);
      for (const deal of result.deals) {
        expect(deal.assignedRepId).toBe(testUserId);
      }
    });
  });

  describe("updateDeal", () => {
    it("should update specific fields", async () => {
      const deal = await createDeal(tenantDb, { name: "Update Me", stageId: ddStageId, assignedRepId: testUserId });

      const updated = await updateDeal(tenantDb, deal.id, { name: "Updated Name", description: "New description" }, "admin", testUserId);

      expect(updated.name).toBe("Updated Name");
      expect(updated.description).toBe("New description");
    });

    it("should not change unspecified fields", async () => {
      const deal = await createDeal(tenantDb, {
        name: "Keep Source",
        stageId: ddStageId,
        assignedRepId: testUserId,
        source: "Referral",
      });

      const updated = await updateDeal(tenantDb, deal.id, { name: "Changed Name" }, "admin", testUserId);

      expect(updated.name).toBe("Changed Name");
      expect(updated.source).toBe("Referral"); // Unchanged
    });
  });

  describe("deleteDeal", () => {
    it("should soft-delete for directors", async () => {
      const deal = await createDeal(tenantDb, { name: "Delete Me", stageId: ddStageId, assignedRepId: testUserId });

      const deleted = await deleteDeal(tenantDb, deal.id, "director");
      expect(deleted.isActive).toBe(false);
    });

    it("should reject delete for reps", async () => {
      const deal = await createDeal(tenantDb, { name: "Cant Delete", stageId: ddStageId, assignedRepId: testUserId });

      await expect(deleteDeal(tenantDb, deal.id, "rep")).rejects.toThrow("Only directors and admins");
    });
  });

  describe("getDealsForPipeline", () => {
    it("should return deals grouped by stage", async () => {
      const result = await getDealsForPipeline(tenantDb, "admin", testUserId);

      expect(result.pipelineColumns).toBeDefined();
      expect(result.terminalStages).toBeDefined();
      expect(Array.isArray(result.pipelineColumns)).toBe(true);
      expect(Array.isArray(result.terminalStages)).toBe(true);

      // Terminal stages should include closed_won and closed_lost
      const terminalSlugs = result.terminalStages.map((ts) => ts.stage.slug);
      expect(terminalSlugs).toContain("closed_won");
      expect(terminalSlugs).toContain("closed_lost");
    });
  });
});
```

### 4b. Stage Gate Tests

**File: `server/tests/modules/deals/stage-gate.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../../src/db.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { createDeal } from "../../src/modules/deals/service.js";
import { validateStageGate } from "../../src/modules/deals/stage-gate.js";

let client: any;
let tenantDb: ReturnType<typeof drizzle>;
let stageMap: Map<string, { id: string; displayOrder: number }>;
let testUserId: string;

describe("Stage Gate Validation", () => {
  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = 'office_dallas', 'public'");
    tenantDb = drizzle(client, { schema });

    // Build stage map
    stageMap = new Map();
    const stages = await client.query("SELECT id, slug, display_order FROM public.pipeline_stage_config");
    for (const row of stages.rows) {
      stageMap.set(row.slug, { id: row.id, displayOrder: row.display_order });
    }

    const users = await client.query("SELECT id FROM public.users WHERE role = 'rep' LIMIT 1");
    testUserId = users.rows[0].id;
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("should allow forward move for reps when no requirements", async () => {
    const deal = await createDeal(tenantDb, {
      name: "Forward Test",
      stageId: stageMap.get("dd")!.id,
      assignedRepId: testUserId,
    });

    const result = await validateStageGate(tenantDb, deal.id, stageMap.get("estimating")!.id, "rep");

    expect(result.allowed).toBe(true);
    expect(result.isBackwardMove).toBe(false);
  });

  it("should block backward move for reps", async () => {
    const deal = await createDeal(tenantDb, {
      name: "Backward Block Test",
      stageId: stageMap.get("estimating")!.id,
      assignedRepId: testUserId,
    });

    const result = await validateStageGate(tenantDb, deal.id, stageMap.get("dd")!.id, "rep");

    expect(result.allowed).toBe(false);
    expect(result.isBackwardMove).toBe(true);
    expect(result.blockReason).toContain("Reps cannot move deals backward");
  });

  it("should allow backward move for directors with override flag", async () => {
    const deal = await createDeal(tenantDb, {
      name: "Director Backward Test",
      stageId: stageMap.get("estimating")!.id,
      assignedRepId: testUserId,
    });

    const result = await validateStageGate(tenantDb, deal.id, stageMap.get("dd")!.id, "director");

    expect(result.allowed).toBe(true);
    expect(result.isBackwardMove).toBe(true);
    expect(result.requiresOverride).toBe(true);
    expect(result.overrideType).toBe("backward_move");
  });

  it("should detect terminal stage correctly", async () => {
    const deal = await createDeal(tenantDb, {
      name: "Terminal Test",
      stageId: stageMap.get("close_out")!.id,
      assignedRepId: testUserId,
    });

    const result = await validateStageGate(tenantDb, deal.id, stageMap.get("closed_won")!.id, "rep");

    expect(result.isTerminal).toBe(true);
    expect(result.targetStage.slug).toBe("closed_won");
  });

  it("should return no-op for same stage", async () => {
    const deal = await createDeal(tenantDb, {
      name: "Same Stage Test",
      stageId: stageMap.get("dd")!.id,
      assignedRepId: testUserId,
    });

    const result = await validateStageGate(tenantDb, deal.id, stageMap.get("dd")!.id, "rep");

    expect(result.allowed).toBe(true);
    expect(result.isBackwardMove).toBe(false);
    expect(result.requiresOverride).toBe(false);
  });
});
```

### 4c. Routes Integration Tests

**File: `server/tests/modules/deals/routes.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";

const app = createApp();

let authCookie: string;
let directorCookie: string;

describe("Deal API Routes", () => {
  beforeAll(async () => {
    // Login as rep via dev auth
    const repLogin = await request(app)
      .post("/api/auth/dev/login")
      .send({ email: "brett.johnson@trockconstruction.com" });
    authCookie = repLogin.headers["set-cookie"]?.[0] ?? "";

    // Login as director
    const dirLogin = await request(app)
      .post("/api/auth/dev/login")
      .send({ email: "takashi.yamamoto@trockconstruction.com" });
    directorCookie = dirLogin.headers["set-cookie"]?.[0] ?? "";
  });

  describe("GET /api/deals", () => {
    it("should return deals list with pagination", async () => {
      const res = await request(app)
        .get("/api/deals")
        .set("Cookie", authCookie)
        .expect(200);

      expect(res.body.deals).toBeDefined();
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
    });

    it("should reject unauthenticated requests", async () => {
      await request(app).get("/api/deals").expect(401);
    });
  });

  describe("POST /api/deals", () => {
    it("should create a deal and return it", async () => {
      // Get DD stage ID first
      const stagesRes = await request(app)
        .get("/api/pipeline/stages")
        .set("Cookie", authCookie);
      const ddStage = stagesRes.body.stages.find((s: any) => s.slug === "dd");

      const res = await request(app)
        .post("/api/deals")
        .set("Cookie", authCookie)
        .send({
          name: "API Test Deal",
          stageId: ddStage.id,
        })
        .expect(201);

      expect(res.body.deal.name).toBe("API Test Deal");
      expect(res.body.deal.dealNumber).toBeDefined();
    });

    it("should require name and stageId", async () => {
      await request(app)
        .post("/api/deals")
        .set("Cookie", authCookie)
        .send({ name: "No Stage" })
        .expect(400);
    });
  });

  describe("POST /api/deals/:id/stage", () => {
    it("should advance deal to next stage", async () => {
      const stagesRes = await request(app)
        .get("/api/pipeline/stages")
        .set("Cookie", authCookie);
      const stages = stagesRes.body.stages;
      const dd = stages.find((s: any) => s.slug === "dd");
      const estimating = stages.find((s: any) => s.slug === "estimating");

      // Create deal in DD
      const createRes = await request(app)
        .post("/api/deals")
        .set("Cookie", authCookie)
        .send({ name: "Stage Test", stageId: dd.id });
      const dealId = createRes.body.deal.id;

      // Advance to Estimating
      const res = await request(app)
        .post(`/api/deals/${dealId}/stage`)
        .set("Cookie", authCookie)
        .send({ targetStageId: estimating.id })
        .expect(200);

      expect(res.body.deal.stageId).toBe(estimating.id);
      expect(res.body.eventsEmitted).toContain("deal.stage.changed");
    });

    it("should block backward move for rep", async () => {
      const stagesRes = await request(app)
        .get("/api/pipeline/stages")
        .set("Cookie", authCookie);
      const stages = stagesRes.body.stages;
      const dd = stages.find((s: any) => s.slug === "dd");
      const estimating = stages.find((s: any) => s.slug === "estimating");

      // Create deal in Estimating
      const createRes = await request(app)
        .post(`/api/deals`)
        .set("Cookie", authCookie)
        .send({ name: "Backward Test", stageId: estimating.id });
      const dealId = createRes.body.deal.id;

      // Try to move backward as rep
      await request(app)
        .post(`/api/deals/${dealId}/stage`)
        .set("Cookie", authCookie)
        .send({ targetStageId: dd.id })
        .expect(403);
    });

    it("should require lost fields for Closed Lost", async () => {
      const stagesRes = await request(app)
        .get("/api/pipeline/stages")
        .set("Cookie", directorCookie);
      const stages = stagesRes.body.stages;
      const bidSent = stages.find((s: any) => s.slug === "bid_sent");
      const closedLost = stages.find((s: any) => s.slug === "closed_lost");

      const createRes = await request(app)
        .post("/api/deals")
        .set("Cookie", directorCookie)
        .send({ name: "Lost Test", stageId: bidSent.id });
      const dealId = createRes.body.deal.id;

      // Try without lost fields
      await request(app)
        .post(`/api/deals/${dealId}/stage`)
        .set("Cookie", directorCookie)
        .send({ targetStageId: closedLost.id })
        .expect(400);
    });
  });

  describe("DELETE /api/deals/:id", () => {
    it("should block deletion for reps", async () => {
      const stagesRes = await request(app)
        .get("/api/pipeline/stages")
        .set("Cookie", authCookie);
      const dd = stagesRes.body.stages.find((s: any) => s.slug === "dd");

      const createRes = await request(app)
        .post("/api/deals")
        .set("Cookie", authCookie)
        .send({ name: "Delete Block", stageId: dd.id });

      await request(app)
        .delete(`/api/deals/${createRes.body.deal.id}`)
        .set("Cookie", authCookie)
        .expect(403);
    });
  });
});
```

---

## Task 5: Stale Deal Worker Job

- [ ] Create `worker/src/jobs/stale-deals.ts`
- [ ] Register in `worker/src/jobs/index.ts`

### 5a. Stale Deal Scanner

**File: `worker/src/jobs/stale-deals.ts`**

```typescript
import { pool } from "../db.js";

/**
 * Scans all active deals across all offices for stale deals.
 *
 * A deal is "stale" when:
 * - It's in a non-terminal stage
 * - The stage has a stale_threshold_days configured
 * - stage_entered_at is older than NOW() - threshold days
 *
 * For each stale deal found:
 * 1. Creates a notification for the assigned rep
 * 2. Creates a notification for all directors in the rep's office
 * 3. Creates a task of type 'stale_deal' for the assigned rep
 *
 * This job runs daily at 6am via node-cron.
 */
export async function runStaleDealScan(): Promise<void> {
  console.log("[Worker:stale-deals] Starting stale deal scan...");

  const client = await pool.connect();
  try {
    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalStale = 0;

    for (const office of offices.rows) {
      const schemaName = `office_${office.slug}`;

      // Find stale deals: join deals with pipeline config, check threshold
      const staleDeals = await client.query(
        `SELECT
           d.id AS deal_id,
           d.name AS deal_name,
           d.deal_number,
           d.assigned_rep_id,
           d.stage_entered_at,
           psc.name AS stage_name,
           psc.stale_threshold_days,
           EXTRACT(DAY FROM NOW() - d.stage_entered_at)::int AS days_in_stage
         FROM ${schemaName}.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE d.is_active = true
           AND psc.is_terminal = false
           AND psc.stale_threshold_days IS NOT NULL
           AND d.stage_entered_at < NOW() - (psc.stale_threshold_days || ' days')::interval`
      );

      if (staleDeals.rows.length === 0) {
        continue;
      }

      console.log(`[Worker:stale-deals] Found ${staleDeals.rows.length} stale deals in office ${office.slug}`);
      totalStale += staleDeals.rows.length;

      for (const staleDeal of staleDeals.rows) {
        // Check if a stale_deal notification already exists for this deal today
        // (avoid duplicate notifications on repeated scans)
        const existingNotification = await client.query(
          `SELECT id FROM ${schemaName}.notifications
           WHERE type = 'stale_deal'
             AND link LIKE $1
             AND created_at > CURRENT_DATE
           LIMIT 1`,
          [`%/deals/${staleDeal.deal_id}%`]
        );

        if (existingNotification.rows.length > 0) {
          continue; // Already notified today
        }

        const title = `Stale Deal: ${staleDeal.deal_name}`;
        const body = `${staleDeal.deal_number} has been in "${staleDeal.stage_name}" for ${staleDeal.days_in_stage} days (threshold: ${staleDeal.stale_threshold_days} days)`;
        const link = `/deals/${staleDeal.deal_id}`;

        // Notify the assigned rep
        await client.query(
          `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
           VALUES ($1, 'stale_deal', $2, $3, $4)`,
          [staleDeal.assigned_rep_id, title, body, link]
        );

        // Notify all directors/admins in this office
        const directors = await client.query(
          `SELECT id FROM public.users
           WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
          [office.id]
        );

        for (const director of directors.rows) {
          await client.query(
            `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
             VALUES ($1, 'stale_deal', $2, $3, $4)`,
            [director.id, title, body, link]
          );
        }

        // Create a stale_deal task for the rep (if one doesn't exist for today)
        const existingTask = await client.query(
          `SELECT id FROM ${schemaName}.tasks
           WHERE type = 'stale_deal'
             AND deal_id = $1
             AND status IN ('pending', 'in_progress')
           LIMIT 1`,
          [staleDeal.deal_id]
        );

        if (existingTask.rows.length === 0) {
          await client.query(
            `INSERT INTO ${schemaName}.tasks
             (title, description, type, priority, status, assigned_to, deal_id, due_date)
             VALUES ($1, $2, 'stale_deal', 'high', 'pending', $3, $4, CURRENT_DATE)`,
            [
              `Follow up on stale deal: ${staleDeal.deal_number}`,
              body,
              staleDeal.assigned_rep_id,
              staleDeal.deal_id,
            ]
          );
        }
      }
    }

    console.log(`[Worker:stale-deals] Scan complete. Total stale deals: ${totalStale}`);
  } catch (err) {
    console.error("[Worker:stale-deals] Scan failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
```

### 5b. Register Stale Deal Job

**File: `worker/src/jobs/index.ts`** -- Add the stale deal cron job:

Add import at top:
```typescript
import { runStaleDealScan } from "./stale-deals.js";
```

Add to `registerAllJobs()`:
```typescript
  registerJobHandler("stale_deal_scan", async () => {
    await runStaleDealScan();
  });

  // Add deal.won and deal.lost domain event handlers
  domainEventHandlers.set("deal.won", async (payload, officeId) => {
    console.log(`[Worker] Deal won: ${payload.dealNumber} (${payload.dealName}) - amount: ${payload.awardedAmount}`);
    // Future: Procore project creation, congratulations notification
  });

  domainEventHandlers.set("deal.lost", async (payload, officeId) => {
    console.log(`[Worker] Deal lost: ${payload.dealNumber} (${payload.dealName}) - reason: ${payload.lostReasonId}`);
    // Future: Lost deal analytics, competitor tracking
  });

  domainEventHandlers.set("deal.stage.changed", async (payload, officeId) => {
    console.log(`[Worker] Stage changed: ${payload.dealNumber} from ${payload.fromStageName} to ${payload.toStageName}`);
    // Future: Procore status sync, stage change email notifications
  });
```

### 5c. Add Cron Schedule in Worker Entry

In `worker/src/index.ts`, add the daily cron for stale deal scanning. The pattern is already established. Add:

```typescript
import cron from "node-cron";
import { runStaleDealScan } from "./jobs/stale-deals.js";

// Stale deal scan: daily at 6:00 AM CT
cron.schedule("0 6 * * *", async () => {
  console.log("[Worker:cron] Running stale deal scan...");
  try {
    await runStaleDealScan();
  } catch (err) {
    console.error("[Worker:cron] Stale deal scan failed:", err);
  }
}, { timezone: "America/Chicago" });
```

---

## Task 6: Frontend -- Deal Utilities and Hooks

- [ ] Create `client/src/lib/deal-utils.ts`
- [ ] Create `client/src/hooks/use-deals.ts`
- [ ] Create `client/src/hooks/use-pipeline-config.ts`
- [ ] Create `client/src/hooks/use-deal-filters.ts`

### 6a. Deal Utilities

**File: `client/src/lib/deal-utils.ts`**

```typescript
/**
 * Format a numeric string as currency (USD).
 */
export function formatCurrency(value: string | number | null | undefined): string {
  if (value == null) return "--";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Format a numeric string as compact currency (e.g., $1.5M).
 */
export function formatCurrencyCompact(value: string | number | null | undefined): string {
  if (value == null) return "--";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(num);
}

/**
 * Calculate current contract value: awarded_amount + change_order_total.
 */
export function currentContractValue(deal: {
  awardedAmount?: string | null;
  changeOrderTotal?: string | null;
}): number {
  const awarded = parseFloat(deal.awardedAmount ?? "0") || 0;
  const coTotal = parseFloat(deal.changeOrderTotal ?? "0") || 0;
  return awarded + coTotal;
}

/**
 * Get the "best estimate" for a deal -- awarded > bid > dd.
 */
export function bestEstimate(deal: {
  awardedAmount?: string | null;
  bidEstimate?: string | null;
  ddEstimate?: string | null;
}): number {
  const awarded = parseFloat(deal.awardedAmount ?? "0");
  if (awarded > 0) return awarded;
  const bid = parseFloat(deal.bidEstimate ?? "0");
  if (bid > 0) return bid;
  return parseFloat(deal.ddEstimate ?? "0") || 0;
}

/**
 * Calculate days in current stage.
 */
export function daysInStage(stageEnteredAt: string | Date | null): number {
  if (!stageEnteredAt) return 0;
  const entered = new Date(stageEnteredAt);
  const now = new Date();
  return Math.floor((now.getTime() - entered.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Format relative time (e.g., "3 days ago", "2 hours ago").
 */
export function timeAgo(date: string | Date | null): string {
  if (!date) return "--";
  const d = new Date(date);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Format a date as M/D/YYYY.
 */
export function formatDate(date: string | Date | null): string {
  if (!date) return "--";
  return new Date(date).toLocaleDateString("en-US");
}

/**
 * Get win probability color for badges.
 */
export function winProbabilityColor(probability: number | null): string {
  if (probability == null) return "bg-gray-100 text-gray-600";
  if (probability >= 75) return "bg-green-100 text-green-700";
  if (probability >= 50) return "bg-yellow-100 text-yellow-700";
  if (probability >= 25) return "bg-orange-100 text-orange-700";
  return "bg-red-100 text-red-700";
}
```

### 6b. Pipeline Config Hook

**File: `client/src/hooks/use-pipeline-config.ts`**

```typescript
import { useState, useEffect } from "react";
import { api } from "@/lib/api";

interface PipelineStage {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isActivePipeline: boolean;
  isTerminal: boolean;
  requiredFields: string[];
  requiredDocuments: string[];
  requiredApprovals: string[];
  staleThresholdDays: number | null;
  procoreStageMapping: string | null;
  color: string | null;
}

interface LostReason {
  id: string;
  label: string;
  isActive: boolean;
  displayOrder: number;
}

interface ProjectType {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  displayOrder: number;
  isActive: boolean;
}

interface Region {
  id: string;
  name: string;
  slug: string;
  states: string[];
  displayOrder: number;
  isActive: boolean;
}

export function usePipelineStages() {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ stages: PipelineStage[] }>("/pipeline/stages")
      .then((data) => {
        if (!cancelled) setStages(data.stages);
      })
      .catch((err) => console.error("Failed to load stages:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { stages, loading };
}

export function useLostReasons() {
  const [reasons, setReasons] = useState<LostReason[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ reasons: LostReason[] }>("/pipeline/lost-reasons")
      .then((data) => { if (!cancelled) setReasons(data.reasons); })
      .catch((err) => console.error("Failed to load lost reasons:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { reasons, loading };
}

export function useProjectTypes() {
  const [projectTypes, setProjectTypes] = useState<ProjectType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ projectTypes: ProjectType[] }>("/pipeline/project-types")
      .then((data) => { if (!cancelled) setProjectTypes(data.projectTypes); })
      .catch((err) => console.error("Failed to load project types:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Build hierarchy: parent types with children
  const hierarchy = projectTypes
    .filter((t) => t.parentId == null)
    .map((parent) => ({
      ...parent,
      children: projectTypes.filter((t) => t.parentId === parent.id),
    }));

  return { projectTypes, hierarchy, loading };
}

export function useRegions() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ regions: Region[] }>("/pipeline/regions")
      .then((data) => { if (!cancelled) setRegions(data.regions); })
      .catch((err) => console.error("Failed to load regions:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { regions, loading };
}
```

### 6c. Deals Hook

**File: `client/src/hooks/use-deals.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Deal {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  assignedRepId: string;
  primaryContactId: string | null;
  ddEstimate: string | null;
  bidEstimate: string | null;
  awardedAmount: string | null;
  changeOrderTotal: string | null;
  description: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  projectTypeId: string | null;
  regionId: string | null;
  source: string | null;
  winProbability: number | null;
  procoreProjectId: number | null;
  procoreBidId: number | null;
  procoreLastSyncedAt: string | null;
  lostReasonId: string | null;
  lostNotes: string | null;
  lostCompetitor: string | null;
  lostAt: string | null;
  expectedCloseDate: string | null;
  actualCloseDate: string | null;
  lastActivityAt: string | null;
  stageEnteredAt: string;
  isActive: boolean;
  hubspotDealId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DealDetail extends Deal {
  stageHistory: Array<{
    id: string;
    dealId: string;
    fromStageId: string | null;
    toStageId: string;
    changedBy: string;
    isBackwardMove: boolean;
    isDirectorOverride: boolean;
    overrideReason: string | null;
    durationInPreviousStage: string | null;
    createdAt: string;
  }>;
  approvals: Array<{
    id: string;
    dealId: string;
    targetStageId: string;
    requiredRole: string;
    requestedBy: string;
    approvedBy: string | null;
    status: string;
    notes: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  changeOrders: Array<{
    id: string;
    dealId: string;
    coNumber: number;
    title: string;
    amount: string;
    status: string;
    procoreCoId: number | null;
    approvedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface DealFilters {
  search?: string;
  stageIds?: string[];
  assignedRepId?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  isActive?: boolean;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useDeals(filters: DealFilters = {}) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.stageIds?.length) params.set("stageIds", filters.stageIds.join(","));
      if (filters.assignedRepId) params.set("assignedRepId", filters.assignedRepId);
      if (filters.projectTypeId) params.set("projectTypeId", filters.projectTypeId);
      if (filters.regionId) params.set("regionId", filters.regionId);
      if (filters.source) params.set("source", filters.source);
      if (filters.isActive === false) params.set("isActive", "false");
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortDir) params.set("sortDir", filters.sortDir);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ deals: Deal[]; pagination: Pagination }>(
        `/deals${qs ? `?${qs}` : ""}`
      );
      setDeals(data.deals);
      setPagination(data.pagination);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [
    filters.search,
    filters.stageIds?.join(","),
    filters.assignedRepId,
    filters.projectTypeId,
    filters.regionId,
    filters.source,
    filters.isActive,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, pagination, loading, error, refetch: fetchDeals };
}

export function useDealDetail(dealId: string | undefined) {
  const [deal, setDeal] = useState<DealDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDeal = useCallback(async () => {
    if (!dealId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ deal: DealDetail }>(`/deals/${dealId}/detail`);
      setDeal(data.deal);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchDeal();
  }, [fetchDeal]);

  return { deal, loading, error, refetch: fetchDeal };
}

export async function createDeal(input: Partial<Deal> & { name: string; stageId: string }) {
  return api<{ deal: Deal }>("/deals", { method: "POST", json: input });
}

export async function updateDeal(dealId: string, input: Partial<Deal>) {
  return api<{ deal: Deal }>(`/deals/${dealId}`, { method: "PATCH", json: input });
}

export async function changeDealStage(
  dealId: string,
  targetStageId: string,
  options?: {
    overrideReason?: string;
    lostReasonId?: string;
    lostNotes?: string;
    lostCompetitor?: string;
  }
) {
  return api<{ deal: Deal; eventsEmitted: string[] }>(`/deals/${dealId}/stage`, {
    method: "POST",
    json: { targetStageId, ...options },
  });
}

export async function preflightStageCheck(dealId: string, targetStageId: string) {
  return api<{
    allowed: boolean;
    isBackwardMove: boolean;
    isTerminal: boolean;
    targetStage: { id: string; name: string; slug: string; isTerminal: boolean };
    currentStage: { id: string; name: string; slug: string; isTerminal: boolean };
    missingRequirements: {
      fields: string[];
      documents: string[];
      approvals: string[];
    };
    requiresOverride: boolean;
    overrideType: string | null;
    blockReason: string | null;
  }>(`/deals/${dealId}/stage/preflight`, {
    method: "POST",
    json: { targetStageId },
  });
}

export async function deleteDeal(dealId: string) {
  return api<{ success: boolean }>(`/deals/${dealId}`, { method: "DELETE" });
}
```

### 6d. Deal Filters Hook (localStorage persistence)

**File: `client/src/hooks/use-deal-filters.ts`**

```typescript
import { useState, useCallback, useEffect } from "react";
import type { DealFilters } from "./use-deals";

const STORAGE_KEY = "trock-crm-deal-filters";

function loadFilters(): DealFilters {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore parse errors */ }
  return { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
}

function saveFilters(filters: DealFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch { /* ignore quota errors */ }
}

export function useDealFilters() {
  const [filters, setFiltersState] = useState<DealFilters>(loadFilters);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const setFilters = useCallback((update: Partial<DealFilters>) => {
    setFiltersState((prev) => {
      // Reset page to 1 when filters change (except when explicitly setting page)
      const resetPage = update.page === undefined;
      return { ...prev, ...update, ...(resetPage ? { page: 1 } : {}) };
    });
  }, []);

  const resetFilters = useCallback(() => {
    const defaults: DealFilters = { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
    setFiltersState(defaults);
  }, []);

  return { filters, setFilters, resetFilters };
}
```

---

## Task 7: Frontend -- Deal List Page

- [ ] Create `client/src/pages/deals/deal-list-page.tsx`
- [ ] Create `client/src/components/deals/deal-filters.tsx`
- [ ] Create `client/src/components/deals/deal-stage-badge.tsx`
- [ ] Create `client/src/components/deals/deal-estimates-card.tsx`
- [ ] Update `client/src/App.tsx` to add routes

### 7a. Stage Badge Component

**File: `client/src/components/deals/deal-stage-badge.tsx`**

```typescript
import { Badge } from "@/components/ui/badge";
import { usePipelineStages } from "@/hooks/use-pipeline-config";

interface DealStageBadgeProps {
  stageId: string;
  className?: string;
}

// Fallback colors by stage slug
const STAGE_COLORS: Record<string, string> = {
  dd: "bg-slate-100 text-slate-700 border-slate-200",
  estimating: "bg-blue-100 text-blue-700 border-blue-200",
  bid_sent: "bg-indigo-100 text-indigo-700 border-indigo-200",
  in_production: "bg-amber-100 text-amber-700 border-amber-200",
  close_out: "bg-purple-100 text-purple-700 border-purple-200",
  closed_won: "bg-green-100 text-green-700 border-green-200",
  closed_lost: "bg-red-100 text-red-700 border-red-200",
};

export function DealStageBadge({ stageId, className }: DealStageBadgeProps) {
  const { stages } = usePipelineStages();
  const stage = stages.find((s) => s.id === stageId);

  if (!stage) {
    return <Badge variant="outline" className={className}>Unknown</Badge>;
  }

  const colorClass = STAGE_COLORS[stage.slug] ?? "bg-gray-100 text-gray-700 border-gray-200";

  return (
    <Badge variant="outline" className={`${colorClass} ${className ?? ""}`}>
      {stage.name}
    </Badge>
  );
}
```

### 7b. Estimates Card Component

**File: `client/src/components/deals/deal-estimates-card.tsx`**

```typescript
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, currentContractValue } from "@/lib/deal-utils";
import type { Deal } from "@/hooks/use-deals";

interface DealEstimatesCardProps {
  deal: Deal;
}

export function DealEstimatesCard({ deal }: DealEstimatesCardProps) {
  const ccv = currentContractValue(deal);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">Estimates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">DD Estimate</span>
          <span className="text-sm font-medium">{formatCurrency(deal.ddEstimate)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Bid Estimate</span>
          <span className="text-sm font-medium">{formatCurrency(deal.bidEstimate)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Awarded Amount</span>
          <span className="text-sm font-semibold">{formatCurrency(deal.awardedAmount)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Change Orders</span>
          <span className="text-sm font-medium">{formatCurrency(deal.changeOrderTotal)}</span>
        </div>
        <div className="border-t pt-2 flex justify-between items-center">
          <span className="text-sm font-medium">Current Contract Value</span>
          <span className="text-base font-bold text-green-600">{formatCurrency(ccv)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
```

### 7c. Deal Filters Component

**File: `client/src/components/deals/deal-filters.tsx`**

```typescript
import { useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import type { DealFilters as DealFilterValues } from "@/hooks/use-deals";

interface DealFiltersProps {
  filters: DealFilterValues;
  onFilterChange: (update: Partial<DealFilterValues>) => void;
  onReset: () => void;
}

export function DealFilters({ filters, onFilterChange, onReset }: DealFiltersProps) {
  const { stages } = usePipelineStages();
  const { projectTypes } = useProjectTypes();
  const { regions } = useRegions();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activeStages = stages.filter((s) => !s.isTerminal);
  const terminalStages = stages.filter((s) => s.isTerminal);

  const activeFilterCount = [
    filters.stageIds?.length ? 1 : 0,
    filters.projectTypeId ? 1 : 0,
    filters.regionId ? 1 : 0,
    filters.source ? 1 : 0,
    filters.assignedRepId ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-3">
      {/* Search + Filter Toggle */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search deals..."
            className="pl-9"
            value={filters.search ?? ""}
            onChange={(e) => onFilterChange({ search: e.target.value || undefined })}
          />
        </div>
        <Button
          variant={showAdvanced ? "secondary" : "outline"}
          size="icon"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="relative"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-brand-purple text-[10px] text-white flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </Button>
        {activeFilterCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Advanced Filters */}
      {showAdvanced && (
        <div className="flex flex-wrap gap-3 p-3 bg-muted/50 rounded-lg">
          {/* Stage filter */}
          <Select
            value={filters.stageIds?.[0] ?? "all"}
            onValueChange={(val) =>
              onFilterChange({ stageIds: val === "all" ? undefined : [val] })
            }
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stages</SelectItem>
              {activeStages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              {terminalStages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Project Type filter */}
          <Select
            value={filters.projectTypeId ?? "all"}
            onValueChange={(val) =>
              onFilterChange({ projectTypeId: val === "all" ? undefined : val })
            }
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Project Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {projectTypes.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Region filter */}
          <Select
            value={filters.regionId ?? "all"}
            onValueChange={(val) =>
              onFilterChange({ regionId: val === "all" ? undefined : val })
            }
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Regions</SelectItem>
              {regions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Sort */}
          <Select
            value={filters.sortBy ?? "updated_at"}
            onValueChange={(val) => onFilterChange({ sortBy: val })}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated_at">Last Updated</SelectItem>
              <SelectItem value="created_at">Date Created</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="awarded_amount">Awarded Amount</SelectItem>
              <SelectItem value="stage_entered_at">Days in Stage</SelectItem>
              <SelectItem value="expected_close_date">Expected Close</SelectItem>
            </SelectContent>
          </Select>

          {/* Active/Inactive toggle */}
          <Button
            variant={filters.isActive === false ? "secondary" : "outline"}
            size="sm"
            onClick={() =>
              onFilterChange({ isActive: filters.isActive === false ? true : false })
            }
          >
            {filters.isActive === false ? "Showing Inactive" : "Active Only"}
          </Button>
        </div>
      )}
    </div>
  );
}
```

### 7d. Deal List Page

**File: `client/src/pages/deals/deal-list-page.tsx`**

```typescript
import { useNavigate } from "react-router-dom";
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Building2,
  MapPin,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { DealFilters } from "@/components/deals/deal-filters";
import { useDeals } from "@/hooks/use-deals";
import { useDealFilters } from "@/hooks/use-deal-filters";
import {
  formatCurrency,
  bestEstimate,
  daysInStage,
  timeAgo,
} from "@/lib/deal-utils";

export function DealListPage() {
  const navigate = useNavigate();
  const { filters, setFilters, resetFilters } = useDealFilters();
  const { deals, pagination, loading, error } = useDeals(filters);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Deals</h2>
          <p className="text-sm text-muted-foreground">
            {pagination.total} deal{pagination.total !== 1 ? "s" : ""}
          </p>
        </div>
        <Button onClick={() => navigate("/deals/new")}>
          <Plus className="h-4 w-4 mr-2" />
          New Deal
        </Button>
      </div>

      {/* Filters */}
      <DealFilters
        filters={filters}
        onFilterChange={setFilters}
        onReset={resetFilters}
      />

      {/* Error State */}
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      )}

      {/* Deal List */}
      {!loading && deals.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Building2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No deals found</p>
          <p className="text-sm">Try adjusting your filters or create a new deal.</p>
        </div>
      )}

      {!loading && deals.length > 0 && (
        <div className="space-y-2">
          {deals.map((deal) => (
            <Card
              key={deal.id}
              className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => navigate(`/deals/${deal.id}`)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-muted-foreground font-mono">
                      {deal.dealNumber}
                    </span>
                    <DealStageBadge stageId={deal.stageId} />
                  </div>
                  <h3 className="font-semibold truncate">{deal.name}</h3>
                  <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                    {deal.propertyCity && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {deal.propertyCity}, {deal.propertyState}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {daysInStage(deal.stageEnteredAt)}d in stage
                    </span>
                    <span>Updated {timeAgo(deal.updatedAt)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-semibold">
                    {formatCurrency(bestEstimate(deal))}
                  </p>
                  {deal.winProbability != null && (
                    <p className="text-xs text-muted-foreground">
                      {deal.winProbability}% probability
                    </p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setFilters({ page: pagination.page - 1 })}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setFilters({ page: pagination.page + 1 })}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Task 8: Frontend -- Deal Detail Page (Tabbed)

- [ ] Create `client/src/pages/deals/deal-detail-page.tsx`
- [ ] Create `client/src/components/deals/deal-overview-tab.tsx`
- [ ] Create `client/src/components/deals/deal-history-tab.tsx`
- [ ] Create `client/src/components/deals/deal-timeline-tab.tsx`

### 8a. Deal Overview Tab

**File: `client/src/components/deals/deal-overview-tab.tsx`**

```typescript
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealEstimatesCard } from "./deal-estimates-card";
import { DealStageBadge } from "./deal-stage-badge";
import { formatDate, daysInStage, winProbabilityColor } from "@/lib/deal-utils";
import { useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import type { DealDetail } from "@/hooks/use-deals";
import {
  MapPin,
  User,
  Calendar,
  Clock,
  FileText,
  TrendingUp,
} from "lucide-react";

interface DealOverviewTabProps {
  deal: DealDetail;
}

export function DealOverviewTab({ deal }: DealOverviewTabProps) {
  const { projectTypes } = useProjectTypes();
  const { regions } = useRegions();

  const projectType = projectTypes.find((t) => t.id === deal.projectTypeId);
  const region = regions.find((r) => r.id === deal.regionId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Left Column: Details */}
      <div className="lg:col-span-2 space-y-4">
        {/* Stage & Status */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Stage & Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 mb-4">
              <DealStageBadge stageId={deal.stageId} className="text-sm px-3 py-1" />
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {daysInStage(deal.stageEnteredAt)} days in stage
              </span>
              {deal.winProbability != null && (
                <Badge
                  variant="outline"
                  className={winProbabilityColor(deal.winProbability)}
                >
                  <TrendingUp className="h-3 w-3 mr-1" />
                  {deal.winProbability}%
                </Badge>
              )}
            </div>

            {deal.description && (
              <p className="text-sm text-muted-foreground">{deal.description}</p>
            )}
          </CardContent>
        </Card>

        {/* Property Info */}
        {(deal.propertyAddress || deal.propertyCity) && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Property
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              {deal.propertyAddress && <p>{deal.propertyAddress}</p>}
              {deal.propertyCity && (
                <p>
                  {deal.propertyCity}, {deal.propertyState} {deal.propertyZip}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Metadata */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Deal Number</span>
                <p className="font-mono font-medium">{deal.dealNumber}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Source</span>
                <p>{deal.source ?? "--"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Project Type</span>
                <p>{projectType?.name ?? "--"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Region</span>
                <p>{region?.name ?? "--"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Expected Close</span>
                <p className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  {formatDate(deal.expectedCloseDate)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Actual Close</span>
                <p>{formatDate(deal.actualCloseDate)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>{formatDate(deal.createdAt)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Last Activity</span>
                <p>{formatDate(deal.lastActivityAt)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Change Orders */}
        {deal.changeOrders.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Change Orders ({deal.changeOrders.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {deal.changeOrders.map((co) => (
                  <div
                    key={co.id}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div>
                      <span className="text-sm font-medium">CO #{co.coNumber}</span>
                      <span className="text-sm text-muted-foreground ml-2">
                        {co.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {parseFloat(co.amount) >= 0 ? "+" : ""}
                        ${parseFloat(co.amount).toLocaleString()}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          co.status === "approved"
                            ? "bg-green-100 text-green-700"
                            : co.status === "rejected"
                            ? "bg-red-100 text-red-700"
                            : "bg-yellow-100 text-yellow-700"
                        }
                      >
                        {co.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Lost Deal Info */}
        {deal.lostReasonId && (
          <Card className="border-red-200 bg-red-50/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-red-700">
                Lost Deal Details
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <p><span className="text-muted-foreground">Lost Date:</span> {formatDate(deal.lostAt)}</p>
              {deal.lostCompetitor && (
                <p><span className="text-muted-foreground">Competitor:</span> {deal.lostCompetitor}</p>
              )}
              {deal.lostNotes && (
                <p><span className="text-muted-foreground">Notes:</span> {deal.lostNotes}</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Right Column: Estimates + Quick Info */}
      <div className="space-y-4">
        <DealEstimatesCard deal={deal} />

        {/* Procore Link */}
        {deal.procoreProjectId && (
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Procore Project:</span>
                <span className="font-mono">#{deal.procoreProjectId}</span>
              </div>
              {deal.procoreLastSyncedAt && (
                <p className="text-xs text-muted-foreground mt-1">
                  Last synced: {formatDate(deal.procoreLastSyncedAt)}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
```

### 8b. Deal History Tab (Stage History)

**File: `client/src/components/deals/deal-history-tab.tsx`**

```typescript
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealStageBadge } from "./deal-stage-badge";
import { formatDate } from "@/lib/deal-utils";
import type { DealDetail } from "@/hooks/use-deals";
import {
  ArrowRight,
  ArrowLeft,
  Shield,
  Clock,
} from "lucide-react";

interface DealHistoryTabProps {
  deal: DealDetail;
}

export function DealHistoryTab({ deal }: DealHistoryTabProps) {
  if (deal.stageHistory.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock className="h-12 w-12 mx-auto mb-3 opacity-30" />
        <p>No stage history yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {deal.stageHistory.map((entry) => (
        <Card key={entry.id}>
          <CardContent className="py-3 px-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                {entry.fromStageId ? (
                  <>
                    <DealStageBadge stageId={entry.fromStageId} />
                    {entry.isBackwardMove ? (
                      <ArrowLeft className="h-4 w-4 text-orange-500" />
                    ) : (
                      <ArrowRight className="h-4 w-4 text-green-500" />
                    )}
                    <DealStageBadge stageId={entry.toStageId} />
                  </>
                ) : (
                  <>
                    <span className="text-sm text-muted-foreground">Created in</span>
                    <DealStageBadge stageId={entry.toStageId} />
                  </>
                )}

                {entry.isBackwardMove && (
                  <Badge variant="outline" className="bg-orange-100 text-orange-700 border-orange-200 text-xs">
                    Backward
                  </Badge>
                )}
                {entry.isDirectorOverride && (
                  <Badge variant="outline" className="bg-purple-100 text-purple-700 border-purple-200 text-xs">
                    <Shield className="h-3 w-3 mr-1" />
                    Override
                  </Badge>
                )}
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDate(entry.createdAt)}
              </span>
            </div>

            {entry.overrideReason && (
              <p className="text-sm text-muted-foreground mt-2 ml-1 italic">
                Override reason: {entry.overrideReason}
              </p>
            )}

            {entry.durationInPreviousStage && (
              <p className="text-xs text-muted-foreground mt-1 ml-1">
                Time in previous stage: {entry.durationInPreviousStage}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

### 8c. Deal Timeline Tab (Placeholder for Activity Feed)

**File: `client/src/components/deals/deal-timeline-tab.tsx`**

```typescript
import { Clock } from "lucide-react";

interface DealTimelineTabProps {
  dealId: string;
}

/**
 * Activity timeline for the deal. Will be fully implemented in Plan 3 (Activities).
 * For now, shows a placeholder that signals where the feed will go.
 */
export function DealTimelineTab({ dealId }: DealTimelineTabProps) {
  return (
    <div className="text-center py-12 text-muted-foreground">
      <Clock className="h-12 w-12 mx-auto mb-3 opacity-30" />
      <p className="text-lg font-medium">Activity Timeline</p>
      <p className="text-sm">
        Call logs, emails, notes, and meetings for this deal will appear here.
      </p>
      <p className="text-xs mt-2">Coming in Plan 3: Activities & Contacts</p>
    </div>
  );
}
```

### 8d. Deal Detail Page

**File: `client/src/pages/deals/deal-detail-page.tsx`**

```typescript
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Edit,
  Trash2,
  ChevronRight,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { DealOverviewTab } from "@/components/deals/deal-overview-tab";
import { DealHistoryTab } from "@/components/deals/deal-history-tab";
import { DealTimelineTab } from "@/components/deals/deal-timeline-tab";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { useDealDetail, deleteDeal as apiDeleteDeal } from "@/hooks/use-deals";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { useAuth } from "@/lib/auth";
import { formatCurrency, bestEstimate } from "@/lib/deal-utils";

type Tab = "overview" | "files" | "email" | "timeline" | "history";

export function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { deal, loading, error, refetch } = useDealDetail(id);
  const { stages } = usePipelineStages();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [stageChangeTarget, setStageChangeTarget] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-64 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !deal) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Deal not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/deals")}>
          Back to Deals
        </Button>
      </div>
    );
  }

  const currentStage = stages.find((s) => s.id === deal.stageId);
  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";

  // Build stage advancement options
  const forwardStages = stages.filter(
    (s) => s.displayOrder > (currentStage?.displayOrder ?? 0)
  );
  const backwardStages = stages.filter(
    (s) => s.displayOrder < (currentStage?.displayOrder ?? 0) && !s.isTerminal
  );

  const handleStageChange = (targetStageId: string) => {
    setStageChangeTarget(targetStageId);
    setStageChangeOpen(true);
  };

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to delete this deal? This action can be undone by an admin.")) {
      return;
    }
    try {
      await apiDeleteDeal(deal.id);
      navigate("/deals");
    } catch (err: any) {
      alert(err.message);
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "files", label: "Files" },
    { key: "email", label: "Email" },
    { key: "timeline", label: "Timeline" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-1 -ml-2"
            onClick={() => navigate("/deals")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Deals
          </Button>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold">{deal.name}</h2>
            <span className="text-sm text-muted-foreground font-mono">
              {deal.dealNumber}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <DealStageBadge stageId={deal.stageId} />
            <span className="text-lg font-semibold">
              {formatCurrency(bestEstimate(deal))}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Stage Advancement Dropdown */}
          {!currentStage?.isTerminal && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  Move Stage
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {forwardStages.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => handleStageChange(s.id)}
                  >
                    {s.name}
                    {s.isTerminal && (
                      <Badge variant="outline" className="ml-2 text-xs">
                        Terminal
                      </Badge>
                    )}
                  </DropdownMenuItem>
                ))}
                {isDirectorOrAdmin && backwardStages.length > 0 && (
                  <>
                    <div className="px-2 py-1.5 text-xs text-muted-foreground border-t mt-1 pt-1">
                      Move Backward (Director)
                    </div>
                    {backwardStages.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onClick={() => handleStageChange(s.id)}
                        className="text-orange-600"
                      >
                        {s.name}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Reopen button for terminal stages (directors only) */}
          {currentStage?.isTerminal && isDirectorOrAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Reopen Deal</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {stages
                  .filter((s) => !s.isTerminal)
                  .map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onClick={() => handleStageChange(s.id)}
                    >
                      {s.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* More Actions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/deals/${deal.id}/edit`)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit Deal
              </DropdownMenuItem>
              {isDirectorOrAdmin && (
                <DropdownMenuItem
                  onClick={handleDelete}
                  className="text-red-600"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Deal
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-brand-purple text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && <DealOverviewTab deal={deal} />}
      {activeTab === "files" && (
        <div className="text-center py-12 text-muted-foreground">
          <p>File management coming in Plan 4: Files & Photos</p>
        </div>
      )}
      {activeTab === "email" && (
        <div className="text-center py-12 text-muted-foreground">
          <p>Email integration coming in Plan 5: Email</p>
        </div>
      )}
      {activeTab === "timeline" && <DealTimelineTab dealId={deal.id} />}
      {activeTab === "history" && <DealHistoryTab deal={deal} />}

      {/* Stage Change Dialog */}
      {stageChangeOpen && stageChangeTarget && (
        <StageChangeDialog
          deal={deal}
          targetStageId={stageChangeTarget}
          open={stageChangeOpen}
          onOpenChange={setStageChangeOpen}
          onSuccess={() => {
            setStageChangeOpen(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}
```

---

## Task 9: Frontend -- Pipeline Kanban Board

- [ ] Create `client/src/pages/pipeline/pipeline-page.tsx`
- [ ] Create `client/src/components/deals/deal-card.tsx`
- [ ] Install `@dnd-kit/core` and `@dnd-kit/sortable` packages

### 9a. Install DnD Kit

```bash
cd client && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

### 9b. Deal Card (Kanban)

**File: `client/src/components/deals/deal-card.tsx`**

```typescript
import { useNavigate } from "react-router-dom";
import { useDraggable } from "@dnd-kit/core";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  formatCurrencyCompact,
  bestEstimate,
  daysInStage,
  winProbabilityColor,
} from "@/lib/deal-utils";
import type { Deal } from "@/hooks/use-deals";
import { Clock, MapPin, GripVertical } from "lucide-react";

interface DealCardProps {
  deal: Deal;
  isDragging?: boolean;
}

export function DealCard({ deal, isDragging }: DealCardProps) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: deal.id,
    data: { deal },
  });

  const style = transform
    ? {
        transform: `translate(${transform.x}px, ${transform.y}px)`,
        zIndex: 50,
      }
    : undefined;

  const days = daysInStage(deal.stageEnteredAt);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={`p-3 cursor-pointer transition-shadow ${
        isDragging ? "shadow-lg opacity-75" : "hover:shadow-md"
      }`}
      onClick={() => navigate(`/deals/${deal.id}`)}
    >
      <div className="flex items-start gap-2">
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 mb-1">
            <span className="text-[10px] text-muted-foreground font-mono">
              {deal.dealNumber}
            </span>
            <span className="text-sm font-semibold">
              {formatCurrencyCompact(bestEstimate(deal))}
            </span>
          </div>
          <p className="text-sm font-medium truncate">{deal.name}</p>
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <Clock className="h-3 w-3" />
              {days}d
            </span>
            {deal.propertyCity && (
              <span className="flex items-center gap-0.5 truncate">
                <MapPin className="h-3 w-3" />
                {deal.propertyCity}
              </span>
            )}
            {deal.winProbability != null && (
              <Badge
                variant="outline"
                className={`${winProbabilityColor(deal.winProbability)} text-[10px] px-1 py-0`}
              >
                {deal.winProbability}%
              </Badge>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
```

### 9c. Pipeline Kanban Page

**File: `client/src/pages/pipeline/pipeline-page.tsx`**

```typescript
import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { Plus, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealCard } from "@/components/deals/deal-card";
import { StageChangeDialog } from "@/components/deals/stage-change-dialog";
import { api } from "@/lib/api";
import { formatCurrencyCompact } from "@/lib/deal-utils";
import type { Deal } from "@/hooks/use-deals";
import { useAuth } from "@/lib/auth";

interface PipelineColumn {
  stage: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
    displayOrder: number;
    isActivePipeline: boolean;
  };
  deals: Deal[];
  totalValue: number;
  count: number;
}

function DroppableColumn({ column, children }: { column: PipelineColumn; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: column.stage.id });

  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-72 flex flex-col rounded-lg transition-colors ${
        isOver ? "bg-brand-purple/5 ring-2 ring-brand-purple/30" : "bg-muted/30"
      }`}
    >
      {/* Column Header */}
      <div className="p-3 border-b">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold">{column.stage.name}</h3>
          <Badge variant="outline" className="text-xs">
            {column.count}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatCurrencyCompact(column.totalValue)}
        </p>
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2 overflow-y-auto min-h-[200px] max-h-[calc(100vh-280px)]">
        {children}
      </div>
    </div>
  );
}

export function PipelinePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [columns, setColumns] = useState<PipelineColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDd, setShowDd] = useState(false);
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [stageChangeOpen, setStageChangeOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ deal: Deal; targetStageId: string } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const fetchPipeline = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ pipelineColumns: PipelineColumn[] }>(
        `/deals/pipeline?includeDd=${showDd}`
      );
      setColumns(data.pipelineColumns);
    } catch (err) {
      console.error("Failed to load pipeline:", err);
    } finally {
      setLoading(false);
    }
  }, [showDd]);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  const handleDragStart = (event: DragStartEvent) => {
    const deal = event.active.data.current?.deal as Deal;
    setActiveDeal(deal);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDeal(null);
    const { active, over } = event;
    if (!over) return;

    const deal = active.data.current?.deal as Deal;
    const targetStageId = over.id as string;

    // Don't process if dropped on the same stage
    if (deal.stageId === targetStageId) return;

    // Open stage change confirmation dialog
    setPendingMove({ deal, targetStageId });
    setStageChangeOpen(true);
  };

  const handleStageChangeSuccess = () => {
    setStageChangeOpen(false);
    setPendingMove(null);
    fetchPipeline(); // Refresh the board
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="flex gap-4 overflow-x-auto">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-72 h-96 bg-muted animate-pulse rounded-lg flex-shrink-0" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Drag deals between stages to advance them
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDd(!showDd)}
          >
            {showDd ? (
              <>
                <EyeOff className="h-4 w-4 mr-1" />
                Hide DD
              </>
            ) : (
              <>
                <Eye className="h-4 w-4 mr-1" />
                Show DD
              </>
            )}
          </Button>
          <Button onClick={() => navigate("/deals/new")}>
            <Plus className="h-4 w-4 mr-2" />
            New Deal
          </Button>
        </div>
      </div>

      {/* Pipeline Summary */}
      <div className="flex gap-2 text-sm">
        <Badge variant="secondary">
          {columns.reduce((sum, col) => sum + col.count, 0)} deals
        </Badge>
        <Badge variant="secondary">
          {formatCurrencyCompact(
            columns.reduce((sum, col) => sum + col.totalValue, 0)
          )}{" "}
          total pipeline
        </Badge>
      </div>

      {/* Kanban Board */}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <DroppableColumn key={column.stage.id} column={column}>
              {column.deals.length === 0 ? (
                <div className="text-center py-8 text-xs text-muted-foreground">
                  No deals
                </div>
              ) : (
                column.deals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    isDragging={activeDeal?.id === deal.id}
                  />
                ))
              )}
            </DroppableColumn>
          ))}
        </div>

        {/* Drag Overlay */}
        <DragOverlay>
          {activeDeal && <DealCard deal={activeDeal} isDragging />}
        </DragOverlay>
      </DndContext>

      {/* Stage Change Dialog (from drag-and-drop) */}
      {stageChangeOpen && pendingMove && (
        <StageChangeDialog
          deal={pendingMove.deal as any}
          targetStageId={pendingMove.targetStageId}
          open={stageChangeOpen}
          onOpenChange={(open) => {
            setStageChangeOpen(open);
            if (!open) setPendingMove(null);
          }}
          onSuccess={handleStageChangeSuccess}
        />
      )}
    </div>
  );
}
```

---

## Task 10: Frontend -- Stage Change UI (Dialog, Lost Modal, Gate Checklist)

- [ ] Create `client/src/components/deals/stage-change-dialog.tsx`
- [ ] Create `client/src/components/deals/lost-deal-modal.tsx`
- [ ] Create `client/src/components/deals/stage-gate-checklist.tsx`
- [ ] Create `client/src/components/deals/backward-move-dialog.tsx`
- [ ] Create `client/src/components/deals/won-deal-modal.tsx`

### 10a. Stage Gate Checklist

**File: `client/src/components/deals/stage-gate-checklist.tsx`**

```typescript
import { CheckCircle2, XCircle, AlertTriangle, FileText, User } from "lucide-react";

interface StageGateChecklistProps {
  missingRequirements: {
    fields: string[];
    documents: string[];
    approvals: string[];
  };
}

// Human-readable field name mapping
const FIELD_LABELS: Record<string, string> = {
  ddEstimate: "DD Estimate",
  bidEstimate: "Bid Estimate",
  awardedAmount: "Awarded Amount",
  expectedCloseDate: "Expected Close Date",
  propertyAddress: "Property Address",
  projectTypeId: "Project Type",
  regionId: "Region",
  primaryContactId: "Primary Contact",
  winProbability: "Win Probability",
  description: "Description",
};

const DOC_LABELS: Record<string, string> = {
  estimate: "Estimate Document",
  contract: "Contract",
  rfp: "RFP",
  proposal: "Proposal",
  permit: "Permit",
  insurance: "Insurance Certificate",
  closeout: "Closeout Package",
};

export function StageGateChecklist({ missingRequirements }: StageGateChecklistProps) {
  const { fields, documents, approvals } = missingRequirements;
  const hasAny = fields.length > 0 || documents.length > 0 || approvals.length > 0;

  if (!hasAny) {
    return (
      <div className="flex items-center gap-2 text-green-600 text-sm">
        <CheckCircle2 className="h-4 w-4" />
        All requirements met
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-amber-600 text-sm font-medium">
        <AlertTriangle className="h-4 w-4" />
        Missing Requirements
      </div>

      {fields.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Required Fields
          </p>
          {fields.map((field) => (
            <div key={field} className="flex items-center gap-2 text-sm text-red-600">
              <XCircle className="h-3.5 w-3.5" />
              {FIELD_LABELS[field] ?? field}
            </div>
          ))}
        </div>
      )}

      {documents.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Required Documents
          </p>
          {documents.map((doc) => (
            <div key={doc} className="flex items-center gap-2 text-sm text-red-600">
              <FileText className="h-3.5 w-3.5" />
              {DOC_LABELS[doc] ?? doc}
            </div>
          ))}
        </div>
      )}

      {approvals.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Required Approvals
          </p>
          {approvals.map((role) => (
            <div key={role} className="flex items-center gap-2 text-sm text-red-600">
              <User className="h-3.5 w-3.5" />
              {role.charAt(0).toUpperCase() + role.slice(1)} approval
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### 10b. Stage Change Dialog (Orchestrator)

This is the main dialog that coordinates all stage change interactions: preflight check, gate display, lost/won modals, backward move override.

**File: `client/src/components/deals/stage-change-dialog.tsx`**

```typescript
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { DealStageBadge } from "./deal-stage-badge";
import { StageGateChecklist } from "./stage-gate-checklist";
import {
  preflightStageCheck,
  changeDealStage,
} from "@/hooks/use-deals";
import { useLostReasons } from "@/hooks/use-pipeline-config";
import { useAuth } from "@/lib/auth";
import { AlertTriangle, ArrowRight, ArrowLeft, Shield, Loader2 } from "lucide-react";

interface StageChangeDialogProps {
  deal: { id: string; name: string; stageId: string };
  targetStageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function StageChangeDialog({
  deal,
  targetStageId,
  open,
  onOpenChange,
  onSuccess,
}: StageChangeDialogProps) {
  const { user } = useAuth();
  const { reasons } = useLostReasons();

  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof preflightStageCheck>> | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [overrideReason, setOverrideReason] = useState("");
  const [lostReasonId, setLostReasonId] = useState("");
  const [lostNotes, setLostNotes] = useState("");
  const [lostCompetitor, setLostCompetitor] = useState("");

  // Run preflight check on mount
  useEffect(() => {
    if (!open) return;
    setPreflightLoading(true);
    setError(null);

    preflightStageCheck(deal.id, targetStageId)
      .then((result) => setPreflight(result))
      .catch((err) => setError(err.message))
      .finally(() => setPreflightLoading(false));
  }, [deal.id, targetStageId, open]);

  const handleSubmit = async () => {
    if (!preflight) return;
    setSubmitting(true);
    setError(null);

    try {
      // Validate lost deal fields
      if (preflight.targetStage.slug === "closed_lost") {
        if (!lostReasonId) {
          setError("Please select a reason for losing this deal.");
          setSubmitting(false);
          return;
        }
        if (!lostNotes.trim()) {
          setError("Please provide notes about why this deal was lost.");
          setSubmitting(false);
          return;
        }
      }

      // Validate override reason
      if (preflight.requiresOverride && !overrideReason.trim()) {
        setError("Please provide a reason for the override.");
        setSubmitting(false);
        return;
      }

      await changeDealStage(deal.id, targetStageId, {
        overrideReason: preflight.requiresOverride ? overrideReason : undefined,
        lostReasonId: preflight.targetStage.slug === "closed_lost" ? lostReasonId : undefined,
        lostNotes: preflight.targetStage.slug === "closed_lost" ? lostNotes : undefined,
        lostCompetitor: preflight.targetStage.slug === "closed_lost" ? lostCompetitor || undefined : undefined,
      });

      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const isBlocked = preflight && !preflight.allowed;
  const isClosedLost = preflight?.targetStage.slug === "closed_lost";
  const isClosedWon = preflight?.targetStage.slug === "closed_won";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {preflight?.isBackwardMove ? (
              <>
                <ArrowLeft className="h-5 w-5 text-orange-500" />
                Move Deal Backward
              </>
            ) : isClosedLost ? (
              <>
                <AlertTriangle className="h-5 w-5 text-red-500" />
                Close Deal as Lost
              </>
            ) : isClosedWon ? (
              "Close Deal as Won"
            ) : (
              "Advance Deal Stage"
            )}
          </DialogTitle>
          <DialogDescription>
            {deal.name}
          </DialogDescription>
        </DialogHeader>

        {preflightLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : preflight ? (
          <div className="space-y-4">
            {/* Stage Transition Display */}
            <div className="flex items-center gap-3 py-2">
              <DealStageBadge stageId={preflight.currentStage.id} />
              {preflight.isBackwardMove ? (
                <ArrowLeft className="h-4 w-4 text-orange-500" />
              ) : (
                <ArrowRight className="h-4 w-4 text-green-500" />
              )}
              <DealStageBadge stageId={preflight.targetStage.id} />
            </div>

            {/* Blocked State */}
            {isBlocked && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700 font-medium">
                  {preflight.blockReason}
                </p>
              </div>
            )}

            {/* Gate Checklist */}
            <StageGateChecklist missingRequirements={preflight.missingRequirements} />

            {/* Override Reason (for directors) */}
            {preflight.requiresOverride && (
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center gap-2 text-sm font-medium text-purple-700">
                  <Shield className="h-4 w-4" />
                  Director Override
                </div>
                <Label htmlFor="overrideReason">
                  Override Reason <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="overrideReason"
                  placeholder="Why are you overriding the requirements?"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </div>
            )}

            {/* Closed Lost Fields */}
            {isClosedLost && (
              <div className="space-y-3 border-t pt-3">
                <p className="text-sm font-medium text-red-700">
                  Required information for closing as lost:
                </p>
                <div className="space-y-2">
                  <Label htmlFor="lostReason">
                    Reason <span className="text-red-500">*</span>
                  </Label>
                  <Select value={lostReasonId} onValueChange={setLostReasonId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select reason..." />
                    </SelectTrigger>
                    <SelectContent>
                      {reasons.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lostNotes">
                    Notes <span className="text-red-500">*</span>
                  </Label>
                  <textarea
                    id="lostNotes"
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="Describe why this deal was lost..."
                    value={lostNotes}
                    onChange={(e) => setLostNotes(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lostCompetitor">Competitor (optional)</Label>
                  <Input
                    id="lostCompetitor"
                    placeholder="Who won the deal?"
                    value={lostCompetitor}
                    onChange={(e) => setLostCompetitor(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Closed Won Confirmation */}
            {isClosedWon && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-700">
                  This will mark the deal as won and set the close date to today.
                  A Procore project will be created automatically.
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
          </div>
        ) : (
          error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isBlocked || preflightLoading || submitting}
            variant={isClosedLost ? "destructive" : "default"}
          >
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isBlocked
              ? "Blocked"
              : isClosedLost
              ? "Close as Lost"
              : isClosedWon
              ? "Close as Won"
              : preflight?.isBackwardMove
              ? "Move Backward"
              : "Advance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Task 11: Frontend -- Deal Creation/Edit Form

- [ ] Create `client/src/components/deals/deal-form.tsx`
- [ ] Create `client/src/pages/deals/deal-new-page.tsx`

### 11a. Deal Form Component

**File: `client/src/components/deals/deal-form.tsx`**

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePipelineStages, useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import { createDeal, updateDeal } from "@/hooks/use-deals";
import type { Deal } from "@/hooks/use-deals";
import { Loader2 } from "lucide-react";

interface DealFormProps {
  deal?: Deal; // If provided, we're editing; otherwise creating
  onSuccess?: (deal: Deal) => void;
}

export function DealForm({ deal, onSuccess }: DealFormProps) {
  const navigate = useNavigate();
  const { stages } = usePipelineStages();
  const { hierarchy: projectTypeHierarchy } = useProjectTypes();
  const { regions } = useRegions();

  const isEdit = !!deal;
  const activeStages = stages.filter((s) => !s.isTerminal);

  const [formData, setFormData] = useState({
    name: deal?.name ?? "",
    stageId: deal?.stageId ?? activeStages[0]?.id ?? "",
    description: deal?.description ?? "",
    ddEstimate: deal?.ddEstimate ?? "",
    bidEstimate: deal?.bidEstimate ?? "",
    awardedAmount: deal?.awardedAmount ?? "",
    propertyAddress: deal?.propertyAddress ?? "",
    propertyCity: deal?.propertyCity ?? "",
    propertyState: deal?.propertyState ?? "",
    propertyZip: deal?.propertyZip ?? "",
    projectTypeId: deal?.projectTypeId ?? "",
    regionId: deal?.regionId ?? "",
    source: deal?.source ?? "",
    winProbability: deal?.winProbability?.toString() ?? "",
    expectedCloseDate: deal?.expectedCloseDate ?? "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError("Deal name is required");
      return;
    }
    if (!formData.stageId && !isEdit) {
      setError("Stage is required");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const payload: any = {
        name: formData.name.trim(),
        description: formData.description.trim() || null,
        ddEstimate: formData.ddEstimate || null,
        bidEstimate: formData.bidEstimate || null,
        awardedAmount: formData.awardedAmount || null,
        propertyAddress: formData.propertyAddress.trim() || null,
        propertyCity: formData.propertyCity.trim() || null,
        propertyState: formData.propertyState.trim() || null,
        propertyZip: formData.propertyZip.trim() || null,
        projectTypeId: formData.projectTypeId || null,
        regionId: formData.regionId || null,
        source: formData.source.trim() || null,
        winProbability: formData.winProbability ? parseInt(formData.winProbability, 10) : null,
        expectedCloseDate: formData.expectedCloseDate || null,
      };

      let result: Deal;
      if (isEdit) {
        const resp = await updateDeal(deal.id, payload);
        result = resp.deal;
      } else {
        payload.stageId = formData.stageId;
        const resp = await createDeal(payload);
        result = resp.deal;
      }

      if (onSuccess) {
        onSuccess(result);
      } else {
        navigate(`/deals/${result.id}`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle>Deal Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">
              Deal Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="name"
              placeholder="e.g., Oakwood Apartments Reroofing"
              value={formData.name}
              onChange={(e) => handleChange("name", e.target.value)}
            />
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="stage">
                Initial Stage <span className="text-red-500">*</span>
              </Label>
              <Select
                value={formData.stageId}
                onValueChange={(val) => handleChange("stageId", val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select stage" />
                </SelectTrigger>
                <SelectContent>
                  {activeStages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <textarea
              id="description"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Brief description of the deal..."
              value={formData.description}
              onChange={(e) => handleChange("description", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="source">Source</Label>
              <Input
                id="source"
                placeholder="e.g., Bid Board, Referral, Cold Call"
                value={formData.source}
                onChange={(e) => handleChange("source", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="winProbability">Win Probability (%)</Label>
              <Input
                id="winProbability"
                type="number"
                min="0"
                max="100"
                placeholder="0-100"
                value={formData.winProbability}
                onChange={(e) => handleChange("winProbability", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="projectType">Project Type</Label>
              <Select
                value={formData.projectTypeId}
                onValueChange={(val) => handleChange("projectTypeId", val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {projectTypeHierarchy.map((parent) => (
                    <div key={parent.id}>
                      <SelectItem value={parent.id} className="font-medium">
                        {parent.name}
                      </SelectItem>
                      {parent.children.map((child) => (
                        <SelectItem key={child.id} value={child.id} className="pl-6">
                          {child.name}
                        </SelectItem>
                      ))}
                    </div>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="region">Region</Label>
              <Select
                value={formData.regionId}
                onValueChange={(val) => handleChange("regionId", val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select region" />
                </SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expectedCloseDate">Expected Close Date</Label>
            <Input
              id="expectedCloseDate"
              type="date"
              value={formData.expectedCloseDate}
              onChange={(e) => handleChange("expectedCloseDate", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Estimates */}
      <Card>
        <CardHeader>
          <CardTitle>Estimates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ddEstimate">DD Estimate ($)</Label>
              <Input
                id="ddEstimate"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.ddEstimate}
                onChange={(e) => handleChange("ddEstimate", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bidEstimate">Bid Estimate ($)</Label>
              <Input
                id="bidEstimate"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.bidEstimate}
                onChange={(e) => handleChange("bidEstimate", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="awardedAmount">Awarded Amount ($)</Label>
              <Input
                id="awardedAmount"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={formData.awardedAmount}
                onChange={(e) => handleChange("awardedAmount", e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Property */}
      <Card>
        <CardHeader>
          <CardTitle>Property Location</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="propertyAddress">Address</Label>
            <Input
              id="propertyAddress"
              placeholder="123 Main St"
              value={formData.propertyAddress}
              onChange={(e) => handleChange("propertyAddress", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="propertyCity">City</Label>
              <Input
                id="propertyCity"
                placeholder="Dallas"
                value={formData.propertyCity}
                onChange={(e) => handleChange("propertyCity", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="propertyState">State</Label>
              <Input
                id="propertyState"
                maxLength={2}
                placeholder="TX"
                value={formData.propertyState}
                onChange={(e) =>
                  handleChange("propertyState", e.target.value.toUpperCase())
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="propertyZip">ZIP</Label>
              <Input
                id="propertyZip"
                maxLength={10}
                placeholder="75201"
                value={formData.propertyZip}
                onChange={(e) => handleChange("propertyZip", e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {isEdit ? "Save Changes" : "Create Deal"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate(-1)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
```

### 11b. New Deal Page

**File: `client/src/pages/deals/deal-new-page.tsx`**

```typescript
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DealForm } from "@/components/deals/deal-form";

export function DealNewPage() {
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-1"
          onClick={() => navigate("/deals")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Deals
        </Button>
        <h2 className="text-2xl font-bold">New Deal</h2>
      </div>
      <DealForm />
    </div>
  );
}
```

---

## Task 12: Update Frontend Routes & Navigation

- [ ] Update `client/src/App.tsx` with new routes
- [ ] Update `client/src/components/layout/sidebar.tsx` with deals nav

### 12a. Update App.tsx Routes

**File: `client/src/App.tsx`** -- Replace the placeholder routes with real page components:

Add imports:
```typescript
import { DealListPage } from "@/pages/deals/deal-list-page";
import { DealDetailPage } from "@/pages/deals/deal-detail-page";
import { DealNewPage } from "@/pages/deals/deal-new-page";
import { PipelinePage } from "@/pages/pipeline/pipeline-page";
```

Replace the pipeline and add deals routes in the `<Route element={<AppShell />}>` block:
```typescript
<Route path="/pipeline" element={<PipelinePage />} />
<Route path="/deals" element={<DealListPage />} />
<Route path="/deals/new" element={<DealNewPage />} />
<Route path="/deals/:id" element={<DealDetailPage />} />
<Route path="/deals/:id/edit" element={<DealDetailPage />} />
```

### 12b. Update Sidebar Navigation

**File: `client/src/components/layout/sidebar.tsx`** -- Add Deals to the nav items:

Add to the imports:
```typescript
import { List } from "lucide-react";
```

Add to the `navItems` array, after Pipeline:
```typescript
{ to: "/deals", icon: List, label: "Deals", roles: ["admin", "director", "rep"] },
```

---

## API Route Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/pipeline/stages` | Tenant | All pipeline stages (ordered) |
| GET | `/api/pipeline/lost-reasons` | Tenant | Active lost deal reasons |
| GET | `/api/pipeline/project-types` | Tenant | Active project types |
| GET | `/api/pipeline/regions` | Tenant | Active regions |
| GET | `/api/deals` | Tenant | List deals (paginated, filtered) |
| GET | `/api/deals/sources` | Tenant | Distinct deal sources |
| GET | `/api/deals/pipeline` | Tenant | Deals grouped by stage (kanban) |
| GET | `/api/deals/:id` | Tenant | Single deal |
| GET | `/api/deals/:id/detail` | Tenant | Deal + history + approvals + COs |
| POST | `/api/deals` | Tenant | Create deal |
| PATCH | `/api/deals/:id` | Tenant | Update deal fields |
| POST | `/api/deals/:id/stage` | Tenant | Change deal stage |
| POST | `/api/deals/:id/stage/preflight` | Tenant | Validate stage gate (read-only) |
| DELETE | `/api/deals/:id` | Tenant + Director | Soft-delete deal |

---

## Edge Cases Covered

| Edge Case | How It's Handled |
|-----------|-----------------|
| Rep tries to move deal backward | `validateStageGate` detects `isBackwardMove`, blocks with `allowed: false` |
| Director backward move | Allowed with `requiresOverride: true`, must provide `overrideReason` |
| Closed Lost without notes | `changeDealStage` requires `lostReasonId` + `lostNotes`, returns 400 |
| Closed Won handling | Sets `actualCloseDate`, emits `deal.won` event |
| Deal reopen from terminal | Director override required. Clears `lostReasonId`, `lostNotes`, `lostAt`, `actualCloseDate` |
| DD excluded from pipeline | `getDealsForPipeline` filters by `isActivePipeline` unless `includeDd=true` |
| Rep sees only own deals | `getDeals` and `getDealById` enforce `assignedRepId = userId` for reps |
| Stage requirements not met | `StageGateChecklist` shows missing fields/documents/approvals |
| Director overrides requirements | Can proceed with logged `overrideReason` in stage history |
| Stale deal detection | Worker scans `stageEnteredAt` vs `staleThresholdDays`, creates notifications + tasks |
| Duplicate stale notifications | Checks for existing notification for same deal on same day |
| Multi-estimate display | `DealEstimatesCard` shows DD, bid, awarded, CO total, and computed CCV |
| Auto-generated deal numbers | `generateDealNumber` creates sequential `TR-{YYYY}-{NNNN}` format |
| Filter persistence | `useDealFilters` stores/loads from localStorage |
| Pipeline drag-and-drop | Opens `StageChangeDialog` with preflight validation before confirming |
| Concurrent deal number generation | Runs within tenant transaction (serializable within `FOR UPDATE` lock implicit in the INSERT sequence) |

---

## Implementation Order

Tasks should be implemented in this order for incremental testability:

1. **Task 1** (Deal Service + API Routes) -- backend CRUD foundation
2. **Task 2** (Stage Gate Validation) -- validation logic, no side effects
3. **Task 3** (Stage Change API) -- ties gate validation to mutations + events
4. **Task 4** (Tests) -- verifies Tasks 1-3
5. **Task 5** (Stale Deal Worker) -- standalone worker job
6. **Task 6** (Frontend Utilities + Hooks) -- shared code for all frontend tasks
7. **Task 7** (Deal List Page) -- first visible frontend feature
8. **Task 8** (Deal Detail Page) -- drill-down from list
9. **Task 9** (Pipeline Kanban) -- visual board with DnD
10. **Task 10** (Stage Change UI) -- dialogs and modals for stage operations
11. **Task 11** (Deal Form) -- create/edit
12. **Task 12** (Routes + Navigation) -- wire everything together

Each task produces working, testable software. Tasks 1-5 are backend-only and can be verified via API tests. Tasks 6-12 build the frontend incrementally.
