import { Router } from "express";
import { and, eq, desc, isNotNull, sql } from "drizzle-orm";
import { dealApprovals, deals, jobQueue } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
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
import { preflightStageCheck } from "./stage-gate.js";
import { getContactsForDeal } from "../contacts/association-service.js";

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

// GET /api/deals/nearby?lat=X&lng=Y — Find nearest deals by GPS coordinates
router.get("/nearby", async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new AppError(400, "Valid lat and lng query parameters are required.");
    }

    const isRep = req.user!.role === "rep";
    const userId = req.user!.id;

    // Haversine distance in miles — filter out NULL coords first to avoid NaN
    const haversine = sql`
      3959 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos(radians(${lat})) * cos(radians(CAST(${deals.propertyLat} AS DOUBLE PRECISION)))
          * cos(radians(CAST(${deals.propertyLng} AS DOUBLE PRECISION)) - radians(${lng}))
          + sin(radians(${lat})) * sin(radians(CAST(${deals.propertyLat} AS DOUBLE PRECISION)))
        ))
      )
    `;

    const conditions = [
      eq(deals.isActive, true),
      isNotNull(deals.propertyLat),
      isNotNull(deals.propertyLng),
    ];

    if (isRep) {
      conditions.push(eq(deals.assignedRepId, userId));
    }

    const nearbyDeals = await req.tenantDb!
      .select({
        id: deals.id,
        dealNumber: deals.dealNumber,
        name: deals.name,
        propertyCity: deals.propertyCity,
        distance: haversine.as("distance"),
      })
      .from(deals)
      .where(and(...conditions))
      .orderBy(haversine)
      .limit(20);

    await req.commitTransaction!();
    res.json({ deals: nearbyDeals });
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

function validateDealPayload(body: Record<string, unknown>): void {
  const MAX_MONEY = 999999999;
  for (const field of ["ddEstimate", "bidEstimate", "awardedAmount"] as const) {
    const val = body[field];
    if (val != null && val !== "") {
      const n = Number(val);
      if (isNaN(n) || n < 0) throw new AppError(400, `${field} must be >= 0`);
      if (n > MAX_MONEY) throw new AppError(400, `${field} must not exceed ${MAX_MONEY}`);
    }
  }
  if (body.winProbability != null && body.winProbability !== "") {
    const wp = Number(body.winProbability);
    if (isNaN(wp) || wp < 0 || wp > 100) {
      throw new AppError(400, "winProbability must be between 0 and 100");
    }
  }
}

// POST /api/deals — create a new deal
router.post("/", async (req, res, next) => {
  try {
    const { name, stageId, assignedRepId, ...rest } = req.body;
    if (!name || !stageId) {
      throw new AppError(400, "Name and stageId are required");
    }
    validateDealPayload(req.body);

    // Rep ownership enforcement:
    // - Reps: force assignedRepId to their own ID (ignore request body value)
    // - Directors/admins: can assign to any user
    let repId: string;
    if (req.user!.role === "rep") {
      repId = req.user!.id; // reps always own their own deals
    } else {
      repId = assignedRepId || req.user!.id;
    }

    const deal = await createDeal(req.tenantDb!, {
      name,
      stageId,
      assignedRepId: repId,
      officeId: req.user!.activeOfficeId,
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
    const body = { ...req.body };
    validateDealPayload(body);

    // Reps cannot change assignedRepId (reassign deals)
    if (req.user!.role === "rep" && body.assignedRepId !== undefined) {
      delete body.assignedRepId;
    }

    const deal = await updateDeal(
      req.tenantDb!,
      req.params.id,
      body,
      req.user!.role,
      req.user!.id,
      req.user!.activeOfficeId,
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

    // Emit local events AFTER successful commit (for SSE push to connected clients).
    // These are best-effort — the durable job_queue entries (inserted inside the
    // transaction above) ensure the worker will process them regardless.
    const eventsToEmit = (result as any)._eventsToEmit ?? [];
    for (const event of eventsToEmit) {
      try {
        eventBus.emitLocal({
          name: event.name,
          payload: event.payload,
          officeId: req.user!.activeOfficeId ?? req.user!.officeId,
          userId: req.user!.id,
          timestamp: new Date(),
        });
      } catch (eventErr) {
        // Swallow — local emission is best-effort; durable jobs handle persistence
        console.error(`[Deals] Failed to emit local event ${event.name}:`, eventErr);
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
      req.user!.role,
      req.user!.id
    );

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/approvals — request approval (rep creates)
router.post("/:id/approvals", async (req, res, next) => {
  try {
    // RBAC: verify the user has access to this deal
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { targetStageId, requiredRole } = req.body;
    if (!targetStageId || !requiredRole) {
      throw new AppError(400, "targetStageId and requiredRole are required");
    }

    const result = await req.tenantDb!
      .insert(dealApprovals)
      .values({
        dealId: req.params.id,
        targetStageId,
        requiredRole,
        requestedBy: req.user!.id,
        status: "pending",
      })
      .returning();

    // Outbox pattern: durable event BEFORE commit so worker gets it
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "approval.requested",
        dealId: req.params.id,
        targetStageId,
        requiredRole,
        requestedBy: req.user!.id,
        approvalId: result[0].id,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();

    // Best-effort local emit for SSE push (already persisted via outbox above)
    try {
      eventBus.emitLocal({
        name: "approval.requested",
        payload: {
          dealId: req.params.id,
          targetStageId,
          requiredRole,
          requestedBy: req.user!.id,
          approvalId: result[0].id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Deals] Failed to emit approval.requested event:", eventErr);
    }

    res.status(201).json({ approval: result[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/approvals/:approvalId — resolve approval (director approves/rejects)
router.patch(
  "/:id/approvals/:approvalId",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const { status, notes } = req.body;
      if (!status || !["approved", "rejected"].includes(status)) {
        throw new AppError(400, "status must be 'approved' or 'rejected'");
      }

      const dealId = req.params.id as string;
      const approvalId = req.params.approvalId as string;

      // RBAC: verify user has access to this deal
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");

      // Fetch the approval and validate state + role
      const [approval] = await req.tenantDb!.select().from(dealApprovals)
        .where(and(eq(dealApprovals.id, approvalId), eq(dealApprovals.dealId, dealId))).limit(1);

      if (!approval) throw new AppError(404, "Approval not found");
      if (approval.status !== "pending") throw new AppError(400, "Approval already resolved");

      const roleHierarchy: Record<string, number> = { rep: 0, director: 1, admin: 2 };
      if (roleHierarchy[req.user!.role] < roleHierarchy[approval.requiredRole]) {
        throw new AppError(403, `Requires ${approval.requiredRole} role to resolve this approval`);
      }

      const result = await req.tenantDb!
        .update(dealApprovals)
        .set({
          status,
          notes: notes ?? null,
          approvedBy: req.user!.id,
          resolvedAt: new Date(),
        })
        .where(eq(dealApprovals.id, approvalId))
        .returning();

      // Outbox pattern: durable event BEFORE commit so worker gets it
      await req.tenantDb!.insert(jobQueue).values({
        jobType: "domain_event",
        payload: {
          eventName: "approval.resolved",
          dealId,
          approvalId,
          status,
          requestedBy: approval.requestedBy,
          resolvedBy: req.user!.id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        status: "pending",
        runAfter: new Date(),
      });

      await req.commitTransaction!();

      // Best-effort local emit for SSE push (already persisted via outbox above)
      try {
        eventBus.emitLocal({
          name: "approval.resolved",
          payload: {
            dealId,
            approvalId,
            status,
            resolvedBy: req.user!.id,
          },
          officeId: req.user!.activeOfficeId ?? req.user!.officeId,
          userId: req.user!.id,
          timestamp: new Date(),
        });
      } catch (eventErr) {
        console.error("[Deals] Failed to emit approval.resolved event:", eventErr);
      }

      res.json({ approval: result[0] });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/deals/:id/approvals — list approvals for a deal
router.get("/:id/approvals", async (req, res, next) => {
  try {
    // RBAC: verify user has access to this deal
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const approvals = await req.tenantDb!
      .select()
      .from(dealApprovals)
      .where(eq(dealApprovals.dealId, req.params.id as string))
      .orderBy(desc(dealApprovals.createdAt));

    await req.commitTransaction!();
    res.json({ approvals });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/contacts — contacts associated with a deal
router.get("/:id/contacts", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const associations = await getContactsForDeal(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ associations });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id — soft-delete (director/admin only)
router.delete("/:id", requireRole("admin", "director"), async (req, res, next) => {
  try {
    await deleteDeal(req.tenantDb!, req.params.id as string, req.user!.role);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const dealRoutes = router;
