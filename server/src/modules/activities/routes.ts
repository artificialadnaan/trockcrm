import { Router } from "express";
import { jobQueue } from "@trock-crm/shared/schema";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { getActivities, createActivity } from "./service.js";

const router = Router();
type ActivitySourceEntityType = "company" | "property" | "lead" | "deal" | "contact";

function inferSourceEntity(body: Record<string, unknown>) {
  const sourceEntityType =
    (body.sourceEntityType as ActivitySourceEntityType | undefined) ??
    (typeof body.leadId === "string"
      ? "lead"
      : typeof body.dealId === "string"
        ? "deal"
        : typeof body.contactId === "string"
          ? "contact"
          : typeof body.propertyId === "string"
            ? "property"
            : typeof body.companyId === "string"
              ? "company"
              : undefined);

  const sourceEntityId =
    (body.sourceEntityId as string | undefined) ??
    (typeof body.leadId === "string"
      ? body.leadId
      : typeof body.dealId === "string"
        ? body.dealId
        : typeof body.contactId === "string"
          ? body.contactId
          : typeof body.propertyId === "string"
            ? body.propertyId
            : typeof body.companyId === "string"
              ? body.companyId
              : undefined);

  return { sourceEntityType, sourceEntityId };
}

// GET /api/activities — list activities (filtered by deal, contact, or user)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      companyId: req.query.companyId as string | undefined,
      propertyId: req.query.propertyId as string | undefined,
      leadId: req.query.leadId as string | undefined,
      dealId: req.query.dealId as string | undefined,
      contactId: req.query.contactId as string | undefined,
      // RBAC: Reps can only see their own activities
      responsibleUserId: req.user!.role === "rep"
        ? req.user!.id
        : ((req.query.responsibleUserId as string | undefined) ??
          (req.query.userId as string | undefined)),
      sourceEntityType: req.query.sourceEntityType as ActivitySourceEntityType | undefined,
      sourceEntityId: req.query.sourceEntityId as string | undefined,
      type: req.query.type as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    // RBAC: If filtering by dealId, verify the user has access to this deal
    if (filters.dealId) {
      const { getDealById } = await import("../deals/service.js");
      const deal = await getDealById(req.tenantDb!, filters.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
    }

    const result = await getActivities(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/activities — create an activity (call, note, meeting)
router.post("/", async (req, res, next) => {
  try {
    const {
      type,
      subject,
      body,
      outcome,
      durationMinutes,
      companyId,
      propertyId,
      leadId,
      dealId,
      contactId,
      occurredAt,
      responsibleUserId: requestedResponsibleUserId,
    } = req.body;
    const { sourceEntityType, sourceEntityId } = inferSourceEntity(req.body as Record<string, unknown>);

    if (!type) throw new AppError(400, "Activity type is required");
    if (!sourceEntityType || !sourceEntityId) {
      throw new AppError(400, "Activity target is required");
    }

    let resolvedResponsibleUserId: string | undefined =
      req.user!.role === "rep" ? req.user!.id : requestedResponsibleUserId;

    // RBAC: If dealId is provided, verify the user has access to this deal
    if (sourceEntityType === "deal") {
      const { getDealById } = await import("../deals/service.js");
      const deal = await getDealById(req.tenantDb!, sourceEntityId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
      resolvedResponsibleUserId ??= deal.assignedRepId;
    }

    if (sourceEntityType === "lead") {
      const { getLeadById } = await import("../leads/service.js");
      const lead = await getLeadById(req.tenantDb!, sourceEntityId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(404, "Lead not found");
      resolvedResponsibleUserId ??= lead.assignedRepId;
    }

    const activity = await createActivity(req.tenantDb!, {
      type,
      responsibleUserId: resolvedResponsibleUserId ?? req.user!.id,
      performedByUserId: req.user!.id,
      sourceEntityType,
      sourceEntityId,
      companyId,
      propertyId,
      leadId,
      dealId,
      contactId,
      subject,
      body,
      outcome,
      durationMinutes,
      occurredAt,
    });

    // Outbox pattern: durable event BEFORE commit so worker gets activity.created
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: DOMAIN_EVENTS.ACTIVITY_CREATED,
        activityId: activity.id,
        type: activity.type,
        userId: activity.responsibleUserId,
        responsibleUserId: activity.responsibleUserId,
        performedByUserId: activity.performedByUserId,
        sourceEntityType: activity.sourceEntityType,
        sourceEntityId: activity.sourceEntityId,
        companyId: activity.companyId,
        propertyId: activity.propertyId,
        leadId: activity.leadId,
        dealId: activity.dealId,
        contactId: activity.contactId,
        subject: activity.subject,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();

    // Best-effort local emit for SSE push
    try {
      eventBus.emitLocal({
        name: DOMAIN_EVENTS.ACTIVITY_CREATED,
        payload: {
          activityId: activity.id,
          type: activity.type,
          userId: activity.responsibleUserId,
          responsibleUserId: activity.responsibleUserId,
          performedByUserId: activity.performedByUserId,
          sourceEntityType: activity.sourceEntityType,
          sourceEntityId: activity.sourceEntityId,
          companyId: activity.companyId,
          propertyId: activity.propertyId,
          leadId: activity.leadId,
          dealId: activity.dealId,
          contactId: activity.contactId,
          subject: activity.subject,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Activities] Failed to emit activity.created event:", eventErr);
    }

    res.status(201).json({ activity });
  } catch (err) {
    next(err);
  }
});

// NOTE: Contact-scoped activity endpoints (POST/GET /api/contacts/:id/activities)
// are mounted on the contacts router (see contacts/routes.ts) to avoid
// duplicate mounting and route ambiguity. Do NOT add them here.

export const activityRoutes = router;
