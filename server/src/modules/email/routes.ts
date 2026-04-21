import { Router } from "express";
import { eq } from "drizzle-orm";
import { contacts } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import { jobQueue } from "@trock-crm/shared/schema";
import {
  sendEmail,
  getEmails,
  getEmailById,
  getEmailThread,
  getEmailThreadForMutation,
  getUserEmails,
  getEmailAssignmentQueue,
  associateEmailToEntity,
  bindThreadToDeal,
  detachThreadByConversation,
  previewThreadReassignmentImpact,
  assertCanMutateEmailThread,
} from "./service.js";
import { getDealById } from "../deals/service.js";
import { getLeadById } from "../leads/service.js";
import { getCompanyById } from "../companies/service.js";
import { getContactById } from "../contacts/service.js";
import { getPropertyDetail } from "../properties/service.js";

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
    res.json(thread);
  } catch (err) {
    next(err);
  }
});

router.post("/thread/:conversationId/assign", async (req, res, next) => {
  try {
    const dealId = req.body.dealId as string | undefined;
    if (!dealId) throw new AppError(400, "dealId is required");

    const thread = await getEmailThreadForMutation(req.tenantDb!, req.params.conversationId);
    await assertCanMutateEmailThread(req.tenantDb!, thread, req.user!);

    const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await bindThreadToDeal(req.tenantDb!, {
      mailboxAccountId: thread.mailboxAccountId,
      providerConversationId: req.params.conversationId,
      dealId,
      actingUserId: req.user!.id,
    });

    const refreshedThread = await getEmailThread(req.tenantDb!, req.params.conversationId, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ ...result, thread: refreshedThread });
  } catch (err) {
    next(err);
  }
});

router.post("/thread/:conversationId/reassign", async (req, res, next) => {
  try {
    const dealId = req.body.dealId as string | undefined;
    if (!dealId) throw new AppError(400, "dealId is required");

    const thread = await getEmailThreadForMutation(req.tenantDb!, req.params.conversationId);
    await assertCanMutateEmailThread(req.tenantDb!, thread, req.user!);

    const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const preview = await previewThreadReassignmentImpact(req.tenantDb!, {
      mailboxAccountId: thread.mailboxAccountId,
      providerConversationId: req.params.conversationId,
      nextDealId: dealId,
    });

    const result = await bindThreadToDeal(req.tenantDb!, {
      mailboxAccountId: thread.mailboxAccountId,
      providerConversationId: req.params.conversationId,
      dealId,
      actingUserId: req.user!.id,
    });

    const refreshedThread = await getEmailThread(req.tenantDb!, req.params.conversationId, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ ...result, preview, thread: refreshedThread });
  } catch (err) {
    next(err);
  }
});

router.post("/thread/:conversationId/detach", async (req, res, next) => {
  try {
    const thread = await getEmailThreadForMutation(req.tenantDb!, req.params.conversationId);
    await assertCanMutateEmailThread(req.tenantDb!, thread, req.user!);

    await detachThreadByConversation(req.tenantDb!, thread.mailboxAccountId, req.params.conversationId, req.user!.id);
    const refreshedThread = await getEmailThread(req.tenantDb!, req.params.conversationId, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ success: true, thread: refreshedThread });
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
    const requestedEntityType = req.body.assignedEntityType as string | undefined;
    const assignedEntityType = (requestedEntityType ?? "deal") as "deal" | "lead" | "property" | "company" | "contact";
    if (!["deal", "lead", "property", "company", "contact"].includes(assignedEntityType)) {
      throw new AppError(400, "Unsupported assignment target");
    }
    const assignedEntityId = (req.body.assignedEntityId as string | undefined) ?? (req.body.dealId as string | undefined);
    const assignedDealId =
      assignedEntityType === "deal"
        ? (req.body.assignedDealId as string | null | undefined) ??
          (req.body.dealId as string | undefined) ??
          assignedEntityId ??
          null
        : null;

    if (!assignedEntityId) {
      throw new AppError(400, "assignedEntityId is required");
    }
    if (assignedEntityType === "deal" && assignedDealId != null && assignedDealId !== assignedEntityId) {
      throw new AppError(400, "assignedDealId must match assignedEntityId for deal assignments");
    }
    if (assignedEntityType !== "deal" && req.body.assignedDealId != null) {
      throw new AppError(400, "assignedDealId is only valid for deal assignments");
    }

    // Verify the email exists and the user has permission to modify it
    const email = await getEmailById(req.tenantDb!, req.params.id);
    if (!email) throw new AppError(404, "Email not found");

    if (req.user!.role === "rep" && email.userId !== req.user!.id) {
      throw new AppError(403, "You can only modify your own emails");
    }

    let emailContactCompanyId: string | null = null;
    if (
      req.user!.role === "rep" &&
      (assignedEntityType === "company" || assignedEntityType === "property" || assignedEntityType === "contact")
    ) {
      if (!email.contactId) {
        throw new AppError(403, "This email does not have enough CRM context for company, property, or contact resolution");
      }

      const [contact] = await req.tenantDb!
        .select({ companyId: contacts.companyId })
        .from(contacts)
        .where(eq(contacts.id, email.contactId))
        .limit(1);

      emailContactCompanyId = contact?.companyId ?? null;
      if (!emailContactCompanyId) {
        throw new AppError(403, "This email does not have enough CRM company context for company, property, or contact resolution");
      }
    }

    if (assignedEntityType === "deal") {
      const deal = await getDealById(req.tenantDb!, assignedEntityId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");
    } else if (assignedEntityType === "contact") {
      const contact = await getContactById(req.tenantDb!, assignedEntityId);
      if (!contact) throw new AppError(404, "Contact not found");
      if (req.user!.role === "rep" && contact.companyId !== emailContactCompanyId) {
        throw new AppError(403, "You can only resolve this email to a contact under its contact company");
      }
    } else if (assignedEntityType === "lead") {
      const lead = await getLeadById(req.tenantDb!, assignedEntityId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(404, "Lead not found");
    } else if (assignedEntityType === "company") {
      const company = await getCompanyById(req.tenantDb!, assignedEntityId);
      if (!company) throw new AppError(404, "Company not found");
      if (req.user!.role === "rep" && emailContactCompanyId !== assignedEntityId) {
        throw new AppError(403, "You can only resolve this email to its contact company");
      }
    } else if (assignedEntityType === "property") {
      const property = await getPropertyDetail(req.tenantDb!, assignedEntityId);
      if (!property) throw new AppError(404, "Property not found");
      if (req.user!.role === "rep" && property.property.companyId !== emailContactCompanyId) {
        throw new AppError(403, "You can only resolve this email to a property under its contact company");
      }
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
