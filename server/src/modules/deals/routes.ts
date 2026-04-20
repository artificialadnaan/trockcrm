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
import { activateServiceHandoff, changeDealStage } from "./stage-change.js";
import { preflightStageCheck } from "./stage-gate.js";
import { getContactsForDeal } from "../contacts/association-service.js";
import {
  getTeamMembers,
  addTeamMember,
  updateTeamMember,
  removeTeamMember,
} from "./team-service.js";
import {
  getEstimate,
  createSection,
  updateSection,
  deleteSection,
  createLineItem,
  updateLineItem,
  deleteLineItem,
} from "./estimate-service.js";
import {
  getPunchList,
  createPunchListItem,
  updatePunchListItem,
  completePunchListItem,
} from "./punch-list-service.js";
import {
  getTimers,
  createTimer,
  completeTimer,
  cancelTimer,
} from "./timer-service.js";
import {
  getCloseoutChecklist,
  initializeCloseoutChecklist,
  toggleChecklistItem,
  updateChecklistItem,
} from "./closeout-service.js";
import {
  DEAL_TEAM_ROLES,
  PUNCH_LIST_TYPES,
  WORKFLOW_TIMER_TYPES,
} from "@trock-crm/shared/types";
import {
  evaluateDealScopingReadiness,
  getOrCreateDealScopingIntake,
  linkDealFileToScopingRequirement,
  routeRevisionToEstimating,
  upsertDealScopingIntake,
} from "./scoping-service.js";
import { confirmUpload } from "../files/service.js";
import {
  createEstimateSourceDocument,
  enqueueEstimateDocumentOcrJob,
} from "../estimating/document-service.js";

const router = Router();

async function queueDomainEvent(
  tenantDb: any,
  officeId: string,
  eventName: string,
  payload: Record<string, unknown>
) {
  await tenantDb.insert(jobQueue).values({
    jobType: "domain_event",
    payload: {
      eventName,
      ...payload,
    },
    officeId,
    status: "pending",
    runAfter: new Date(),
  });
}

async function queueAiEstimateRefresh(tenantDb: any, officeId: string, dealId: string, reason: string) {
  await tenantDb.insert(jobQueue).values([
    {
      jobType: "ai_index_document",
      payload: {
        sourceType: "estimate_snapshot",
        sourceId: dealId,
        dealId,
        reason,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    },
    {
      jobType: "ai_refresh_copilot",
      payload: {
        dealId,
        reason,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    },
  ]);
}

function emitLocalDealEvents(
  events: Array<{ name: string; payload: any }>,
  input: { officeId: string; userId: string }
) {
  for (const event of events) {
    try {
      eventBus.emitLocal({
        name: event.name as any,
        payload: event.payload,
        officeId: input.officeId,
        userId: input.userId,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error(`[Deals] Failed to emit local event ${event.name}:`, eventErr);
    }
  }
}

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

    // All users can see all deals — no rep filtering
    const conditions = [
      eq(deals.isActive, true),
      isNotNull(deals.propertyLat),
      isNotNull(deals.propertyLng),
    ];

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

// GET /api/deals/:id/scoping-intake — load or initialize scoping intake
router.get("/:id/scoping-intake", async (req, res, next) => {
  try {
    const result = await getOrCreateDealScopingIntake(req.tenantDb!, req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/scoping-intake — autosave scoping intake
router.patch("/:id/scoping-intake", async (req, res, next) => {
  try {
    const result = await upsertDealScopingIntake(req.tenantDb!, req.params.id, req.body, req.user!.id);
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const eventsToEmit: Array<{ name: string; payload: Record<string, unknown> }> = [];

    if (result.previousStatus !== result.readiness.status) {
      const payload = {
        dealId: req.params.id,
        intakeId: result.intake.id,
        workflowRoute: result.intake.workflowRouteSnapshot,
        status: result.readiness.status,
        editedBy: req.user!.id,
      };

      if (result.readiness.status === "ready") {
        await queueDomainEvent(req.tenantDb! as any, officeId, "scoping_intake.ready", payload);
        eventsToEmit.push({ name: "scoping_intake.ready", payload });
      }

      if (result.previousStatus === "activated" && result.readiness.status === "draft") {
        await queueDomainEvent(req.tenantDb! as any, officeId, "scoping_intake.reopened", payload);
        eventsToEmit.push({ name: "scoping_intake.reopened", payload });
      }
    }

    await req.commitTransaction!();
    emitLocalDealEvents(eventsToEmit, {
      officeId,
      userId: req.user!.id,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/scoping-intake/readiness — evaluate current readiness
router.get("/:id/scoping-intake/readiness", async (req, res, next) => {
  try {
    const readiness = await evaluateDealScopingReadiness(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ readiness });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/scoping-intake/attachments/link-existing — reuse an existing deal file
router.post("/:id/scoping-intake/attachments/link-existing", async (req, res, next) => {
  try {
    const { fileId, intakeSection, intakeRequirementKey } = req.body;

    if (!fileId || !intakeSection || !intakeRequirementKey) {
      throw new AppError(400, "fileId, intakeSection, and intakeRequirementKey are required");
    }

    const file = await linkDealFileToScopingRequirement(
      req.tenantDb!,
      req.params.id,
      { fileId, intakeSection, intakeRequirementKey },
      req.user!.id
    );
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const payload = {
      dealId: req.params.id,
      fileId: file.id,
      intakeSection: file.intakeSection,
      intakeRequirementKey: file.intakeRequirementKey,
      linkedBy: req.user!.id,
    };
    await queueDomainEvent(
      req.tenantDb! as any,
      officeId,
      "scoping_intake.attachment.added",
      payload
    );

    await req.commitTransaction!();
    emitLocalDealEvents(
      [{ name: "scoping_intake.attachment.added", payload }],
      { officeId, userId: req.user!.id }
    );
    res.json({ file });
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
    const {
      name,
      stageId,
      assignedRepId,
      sourceLeadWriteMode: _sourceLeadWriteMode,
      migrationMode: _migrationMode,
      ...rest
    } = req.body;
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
    delete body.migrationMode;

    // Reps cannot change assignedRepId (reassign deals)
    if (req.user!.role === "rep" && body.assignedRepId !== undefined) {
      delete body.assignedRepId;
    }

    const priorDeal =
      body.proposalStatus === "revision_requested"
        ? await getDealById(
            req.tenantDb!,
            req.params.id,
            req.user!.role,
            req.user!.id
          )
        : null;

    let deal = await updateDeal(
      req.tenantDb!,
      req.params.id,
      body,
      req.user!.role,
      req.user!.id,
      req.user!.activeOfficeId,
    );

    if (body.proposalStatus === "revision_requested") {
      const revisionRouting = await routeRevisionToEstimating(
        req.tenantDb!,
        req.params.id,
        req.user!.id,
        {
          proposalStatus: "revision_requested",
          previousEstimatingSubstage: priorDeal?.estimatingSubstage ?? null,
        }
      );
      deal = revisionRouting.deal;
    }

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

    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_refresh_copilot",
      payload: {
        dealId: req.params.id,
        reason: "deal_stage_changed",
        targetStageId,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();
    emitLocalDealEvents((result as any)._eventsToEmit ?? [], {
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      userId: req.user!.id,
    });

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

// POST /api/deals/:id/service-handoff/activate — activate service workflow once scoping is ready
router.post("/:id/service-handoff/activate", async (req, res, next) => {
  try {
    const result = await activateServiceHandoff(req.tenantDb!, {
      dealId: req.params.id,
      userId: req.user!.id,
      userRole: req.user!.role,
    });

    await req.commitTransaction!();
    emitLocalDealEvents((result as any)._eventsToEmit ?? [], {
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      userId: req.user!.id,
    });
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

// ── Deal Team Members ──────────────────────────────────────────────────────────

// GET /api/deals/:id/team
router.get("/:id/team", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const members = await getTeamMembers(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/team
router.post("/:id/team", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { userId, role, notes } = req.body;
    if (!userId || !role) throw new AppError(400, "userId and role are required");
    if (!DEAL_TEAM_ROLES.includes(role)) throw new AppError(400, "Invalid role");

    const member = await addTeamMember(req.tenantDb!, {
      dealId: req.params.id,
      userId,
      role,
      assignedBy: req.user!.id,
      notes,
    });
    await req.commitTransaction!();
    res.status(201).json({ member });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/team/:memberId
router.patch("/:id/team/:memberId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { role, notes } = req.body;
    if (role !== undefined && !DEAL_TEAM_ROLES.includes(role)) throw new AppError(400, "Invalid role");
    const member = await updateTeamMember(req.tenantDb!, req.params.memberId, req.params.id, { role, notes });
    await req.commitTransaction!();
    res.json({ member });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id/team/:memberId
router.delete("/:id/team/:memberId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    await removeTeamMember(req.tenantDb!, req.params.memberId, req.params.id);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Estimates ──────────────────────────────────────────────────────────────────

// GET /api/deals/:id/estimates
router.get("/:id/estimates", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const estimate = await getEstimate(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(estimate);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/estimating/documents
router.post("/:id/estimating/documents", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const uploadedFile = await confirmUpload(req.tenantDb!, req.user!.id, {
      uploadToken: req.body.uploadToken,
    });

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const document = await createEstimateSourceDocument({
      tenantDb: req.tenantDb!,
      enqueueEstimateDocumentOcr: (payload) =>
        enqueueEstimateDocumentOcrJob(req.tenantDb!, payload),
      input: {
        dealId: req.params.id,
        fileId: uploadedFile.id,
        rootFileId: uploadedFile.parentFileId ?? uploadedFile.id,
        filename: uploadedFile.originalFilename,
        mimeType: uploadedFile.mimeType,
        fileSize: uploadedFile.fileSizeBytes,
        contentHash: uploadedFile.r2Key,
        userId: req.user!.id,
        officeId,
      },
    });

    await req.commitTransaction!();
    res.status(201).json({ document, file: uploadedFile });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/estimates/sections
router.post("/:id/estimates/sections", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { name, displayOrder } = req.body;
    if (!name) throw new AppError(400, "name is required");

    const section = await createSection(req.tenantDb!, req.params.id, name, displayOrder);
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_section_created"
    );
    await req.commitTransaction!();
    res.status(201).json({ section });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/estimates/sections/:sectionId
router.patch("/:id/estimates/sections/:sectionId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { name, displayOrder } = req.body;
    const section = await updateSection(req.tenantDb!, req.params.sectionId, req.params.id, { name, displayOrder });
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_section_updated"
    );
    await req.commitTransaction!();
    res.json({ section });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id/estimates/sections/:sectionId
router.delete("/:id/estimates/sections/:sectionId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    await deleteSection(req.tenantDb!, req.params.sectionId, req.params.id);
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_section_deleted"
    );
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/estimates/sections/:sectionId/items
router.post("/:id/estimates/sections/:sectionId/items", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { description, quantity, unit, unitPrice, notes, displayOrder } = req.body;
    const item = await createLineItem(req.tenantDb!, req.params.id, req.params.sectionId, {
      description,
      quantity,
      unit,
      unitPrice,
      notes,
      displayOrder,
    });
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_item_created"
    );
    await req.commitTransaction!();
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/estimates/items/:itemId
router.patch("/:id/estimates/items/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { description, quantity, unit, unitPrice, notes, displayOrder } = req.body;
    const item = await updateLineItem(req.tenantDb!, req.params.itemId, req.params.id, {
      description,
      quantity,
      unit,
      unitPrice,
      notes,
      displayOrder,
    });
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_item_updated"
    );
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id/estimates/items/:itemId
router.delete("/:id/estimates/items/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    await deleteLineItem(req.tenantDb!, req.params.itemId, req.params.id);
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_item_deleted"
    );
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Punch List ─────────────────────────────────────────────────────────────────

// GET /api/deals/:id/punch-list
router.get("/:id/punch-list", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await getPunchList(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/punch-list
router.post("/:id/punch-list", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { type, title, description, assignedTo, location, priority } = req.body;
    if (type !== undefined && !PUNCH_LIST_TYPES.includes(type)) throw new AppError(400, "Invalid punch list type");
    const item = await createPunchListItem(req.tenantDb!, {
      dealId: req.params.id,
      type,
      title,
      description,
      assignedTo,
      location,
      priority,
      createdBy: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/punch-list/:itemId
router.patch("/:id/punch-list/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { type, title, description, assignedTo, location, priority, status } = req.body;
    if (type !== undefined && !PUNCH_LIST_TYPES.includes(type)) throw new AppError(400, "Invalid punch list type");
    const item = await updatePunchListItem(req.tenantDb!, req.params.itemId, req.params.id, {
      type,
      title,
      description,
      assignedTo,
      location,
      priority,
      status,
    });
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/punch-list/:itemId/complete
router.post("/:id/punch-list/:itemId/complete", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const item = await completePunchListItem(req.tenantDb!, req.params.itemId, req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// ── Workflow Timers ────────────────────────────────────────────────────────────

// GET /api/deals/:id/timers
router.get("/:id/timers", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await getTimers(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/timers
router.post("/:id/timers", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { timerType, label, deadlineAt } = req.body;
    if (!timerType || !deadlineAt) throw new AppError(400, "timerType and deadlineAt are required");
    if (!WORKFLOW_TIMER_TYPES.includes(timerType)) throw new AppError(400, "Invalid timer type");

    const timer = await createTimer(req.tenantDb!, {
      dealId: req.params.id,
      timerType,
      label,
      deadlineAt,
      createdBy: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(201).json({ timer });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/timers/:timerId — complete or cancel
router.patch("/:id/timers/:timerId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { action } = req.body;
    if (!action || !["complete", "cancel"].includes(action)) {
      throw new AppError(400, "action must be 'complete' or 'cancel'");
    }

    const timer =
      action === "complete"
        ? await completeTimer(req.tenantDb!, req.params.timerId, req.params.id)
        : await cancelTimer(req.tenantDb!, req.params.timerId, req.params.id);

    await req.commitTransaction!();
    res.json({ timer });
  } catch (err) {
    next(err);
  }
});

// ── Close-Out Checklist ────────────────────────────────────────────────────────

// GET /api/deals/:id/closeout
router.get("/:id/closeout", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await getCloseoutChecklist(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/closeout/initialize
router.post("/:id/closeout/initialize", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    await initializeCloseoutChecklist(req.tenantDb!, req.params.id);
    const checklist = await getCloseoutChecklist(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(checklist);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/closeout/:itemId — update checklist item (toggle or set notes)
router.patch("/:id/closeout/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { isCompleted, notes } = req.body;
    const item = await updateChecklistItem(
      req.tenantDb!,
      req.params.itemId,
      req.params.id,
      req.user!.id,
      { isCompleted, notes }
    );
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

export const dealRoutes = router;
