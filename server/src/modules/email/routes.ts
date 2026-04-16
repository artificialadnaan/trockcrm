import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import { jobQueue } from "@trock-crm/shared/schema";
import {
  sendEmail,
  getEmails,
  getEmailById,
  getEmailThread,
  getUserEmails,
  getEmailAssignmentQueue,
  associateEmailToEntity,
} from "./service.js";
import { getDealById } from "../deals/service.js";

const router = Router();

// POST /api/email/send — compose and send an email
router.post("/send", async (req, res, next) => {
  try {
    const { to, cc, subject, bodyHtml, dealId, contactId } = req.body;

    if (!to || !Array.isArray(to) || to.length === 0) {
      throw new AppError(400, "At least one recipient (to) is required");
    }
    if (!subject || !subject.trim()) {
      throw new AppError(400, "Subject is required");
    }
    if (!bodyHtml || !bodyHtml.trim()) {
      throw new AppError(400, "Email body is required");
    }

    // Validate dealId access if provided
    if (dealId) {
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found or access denied");
    }

    const email = await sendEmail(req.tenantDb!, req.user!.id, {
      to,
      cc,
      subject: subject.trim(),
      bodyHtml,
      dealId: dealId || null,
      contactId: contactId || null,
    });

    // Durable outbox insert INSIDE the transaction (matches deals pattern)
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: DOMAIN_EVENTS.EMAIL_SENT,
        emailId: email.id,
        to,
        subject: subject.trim(),
        dealId: dealId || null,
        contactId: contactId || null,
        userId: req.user!.id,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();

    // Best-effort local emission AFTER commit (for SSE push to connected clients)
    try {
      eventBus.emitLocal({
        name: DOMAIN_EVENTS.EMAIL_SENT,
        payload: {
          emailId: email.id,
          to,
          subject: subject.trim(),
          dealId: dealId || null,
          contactId: contactId || null,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Email] Failed to emit email.sent local event:", eventErr);
    }

    res.status(201).json({ email });
  } catch (err) {
    next(err);
  }
});

// GET /api/email — user's email inbox (all emails for current user)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getUserEmails(req.tenantDb!, req.user!.id, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/deal/:dealId — emails for a specific deal
// RBAC: verify user has access to this deal before returning emails
router.get("/deal/:dealId", async (req, res, next) => {
  try {
    // Ownership check: reuse existing getDealById which enforces RBAC
    const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const filters = {
      dealId: req.params.dealId,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getEmails(req.tenantDb!, filters, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/contact/:contactId — emails for a specific contact
router.get("/contact/:contactId", async (req, res, next) => {
  try {
    const filters = {
      contactId: req.params.contactId,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getEmails(req.tenantDb!, filters, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/thread/:conversationId — all emails in a thread
router.get("/thread/:conversationId", async (req, res, next) => {
  try {
    const thread = await getEmailThread(req.tenantDb!, req.params.conversationId, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ emails: thread });
  } catch (err) {
    next(err);
  }
});

// GET /api/email/assignment-queue — unresolved assignment queue for inbox triage
router.get("/assignment-queue", async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getEmailAssignmentQueue(
      req.tenantDb!,
      filters,
      req.user!.id,
      req.user!.role
    );
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/:id — single email with full body
// RBAC: only the email owner or a director/admin can view
router.get("/:id", async (req, res, next) => {
  try {
    const email = await getEmailById(req.tenantDb!, req.params.id);
    if (!email) throw new AppError(404, "Email not found");

    const isOwner = email.userId === req.user!.id;
    const isAdmin = req.user!.role === "director" || req.user!.role === "admin";
    if (!isOwner && !isAdmin) {
      throw new AppError(403, "You do not have permission to view this email");
    }

    await req.commitTransaction!();
    res.json({ email });
  } catch (err) {
    next(err);
  }
});

// POST /api/email/:id/associate — manually associate email to a deal
// RBAC: verify user owns the email (if rep) and has access to the target deal when needed
router.post("/:id/associate", async (req, res, next) => {
  try {
    const assignedEntityType =
      (req.body.assignedEntityType as "deal" | "lead" | "property" | "company" | undefined) ??
      (req.body.dealId ? "deal" : undefined);
    const assignedEntityId = (req.body.assignedEntityId as string | undefined) ?? (req.body.dealId as string | undefined);
    const assignedDealId = (req.body.assignedDealId as string | null | undefined) ?? (req.body.dealId as string | undefined) ?? null;

    if (!assignedEntityType || !assignedEntityId) {
      throw new AppError(400, "assignedEntityType and assignedEntityId are required");
    }

    // Verify the email exists and the user has permission to modify it
    const email = await getEmailById(req.tenantDb!, req.params.id);
    if (!email) throw new AppError(404, "Email not found");

    if (req.user!.role === "rep" && email.userId !== req.user!.id) {
      throw new AppError(403, "You can only modify your own emails");
    }

    if (assignedEntityType === "deal") {
      const deal = await getDealById(req.tenantDb!, assignedEntityId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
    }

    await associateEmailToEntity(
      req.tenantDb!,
      req.params.id,
      {
        assignedEntityType,
        assignedEntityId,
        assignedDealId,
      },
      req.user!.role,
      req.user!.id,
      req.user!.activeOfficeId ?? req.user!.officeId
    );
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const emailRoutes = router;
