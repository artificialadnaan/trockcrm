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
  getEmailThreadForMutation,
  getUserEmails,
  getEmailAssignmentQueue,
  associateEmailToEntity,
  ignoreEmailAssignment,
  updateEmailInboxAction,
  unignoreEmailAssignment,
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

type RequestedEmailAssociation = {
  assignedEntityType: "deal" | "lead" | "property" | "company" | "contact";
  assignedEntityId: string;
  assignedDealId: string | null;
};

function parsePaginationParam(
  rawValue: unknown,
  name: "page" | "limit",
  options: { defaultValue?: number; min?: number; max?: number } = {}
) {
  if (rawValue === undefined) return options.defaultValue;
  if (typeof rawValue !== "string" || !/^\d+$/.test(rawValue)) {
    throw new AppError(400, `Invalid ${name} query parameter`);
  }

  const parsed = Number(rawValue);
  const min = options.min ?? 1;
  const max = options.max;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    throw new AppError(400, `Invalid ${name} query parameter`);
  }

  return parsed;
}

function canUserViewDeal(req: any, dealId: string) {
  return getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id)
    .then(Boolean)
    .catch((err) => {
      if (err?.statusCode === 403 || err?.status === 403) {
        return false;
      }
      throw err;
    });
}

async function canUserViewAssignedEmailEntity(
  req: any,
  entityType: string | null | undefined,
  entityId: string | null | undefined
) {
  if (!entityType || !entityId) {
    return false;
  }

  switch (entityType) {
    case "deal":
      return canUserViewDeal(req, entityId);
    case "lead": {
      const lead = await getLeadById(req.tenantDb!, entityId, req.user!.role, req.user!.id);
      return Boolean(lead);
    }
    case "company": {
      const company = await getCompanyById(req.tenantDb!, entityId);
      return Boolean(company);
    }
    case "contact": {
      const contact = await getContactById(req.tenantDb!, entityId);
      return Boolean(contact);
    }
    default:
      return false;
  }
}

function parseRequestedEmailAssociation(
  body: Record<string, unknown>,
  options: {
    allowedTypes?: Array<RequestedEmailAssociation["assignedEntityType"]>;
    allowMissing?: boolean;
  } = {}
): RequestedEmailAssociation | null {
  const allowedTypes = options.allowedTypes ?? ["deal", "lead", "property", "company", "contact"];
  const requestedEntityType = body.assignedEntityType as string | undefined;
  const assignedEntityId = (body.assignedEntityId as string | undefined) ?? (body.dealId as string | undefined);
  const hasExplicitAssociation =
    requestedEntityType !== undefined || assignedEntityId !== undefined || body.assignedDealId != null;

  if (!hasExplicitAssociation && options.allowMissing) {
    return null;
  }

  const assignedEntityType = (requestedEntityType ?? "deal") as RequestedEmailAssociation["assignedEntityType"];
  if (!allowedTypes.includes(assignedEntityType)) {
    throw new AppError(400, "Unsupported assignment target");
  }

  const assignedDealId =
    assignedEntityType === "deal"
      ? ((body.assignedDealId as string | null | undefined) ??
          (body.dealId as string | undefined) ??
          assignedEntityId ??
          null)
      : null;

  if (!assignedEntityId) {
    throw new AppError(400, "assignedEntityId is required");
  }
  if (assignedEntityType === "deal" && assignedDealId != null && assignedDealId !== assignedEntityId) {
    throw new AppError(400, "assignedDealId must match assignedEntityId for deal assignments");
  }
  if (assignedEntityType !== "deal" && body.assignedDealId != null) {
    throw new AppError(400, "assignedDealId is only valid for deal assignments");
  }

  return {
    assignedEntityType,
    assignedEntityId,
    assignedDealId,
  };
}

async function assertRequestedAssociationExists(req: any, association: RequestedEmailAssociation) {
  if (association.assignedEntityType === "deal") {
    const deal = await getDealById(req.tenantDb!, association.assignedEntityId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    return;
  }

  if (association.assignedEntityType === "contact") {
    const contact = await getContactById(req.tenantDb!, association.assignedEntityId);
    if (!contact) throw new AppError(404, "Contact not found");
    return;
  }

  if (association.assignedEntityType === "lead") {
    const lead = await getLeadById(req.tenantDb!, association.assignedEntityId, req.user!.role, req.user!.id);
    if (!lead) throw new AppError(404, "Lead not found");
    return;
  }

  if (association.assignedEntityType === "company") {
    const company = await getCompanyById(req.tenantDb!, association.assignedEntityId);
    if (!company) throw new AppError(404, "Company not found");
    return;
  }

  if (association.assignedEntityType === "property") {
    const property = await getPropertyDetail(req.tenantDb!, association.assignedEntityId);
    if (!property) throw new AppError(404, "Property not found");
  }
}

// POST /api/email/send — compose and send an email
router.post("/send", async (req, res, next) => {
  try {
    const { to, cc, subject, bodyHtml, dealId, contactId } = req.body;
    const association = parseRequestedEmailAssociation(req.body, {
      allowedTypes: ["deal", "lead", "company", "contact"],
      allowMissing: true,
    });

    if (!to || !Array.isArray(to) || to.length === 0) {
      throw new AppError(400, "At least one recipient (to) is required");
    }
    if (!subject || !subject.trim()) {
      throw new AppError(400, "Subject is required");
    }
    if (!bodyHtml || !bodyHtml.trim()) {
      throw new AppError(400, "Email body is required");
    }

    if (association) {
      await assertRequestedAssociationExists(req, association);
    } else if (dealId) {
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found or access denied");
    }

    const email = await sendEmail(req.tenantDb!, req.user!.id, {
      to,
      cc,
      subject: subject.trim(),
      bodyHtml,
      assignedEntityType: association?.assignedEntityType,
      assignedEntityId: association?.assignedEntityId,
      assignedDealId: association?.assignedDealId,
      dealId: association?.assignedEntityType === "deal" ? association.assignedEntityId : dealId || null,
      contactId: association?.assignedEntityType === "contact" ? association.assignedEntityId : contactId || null,
    });

    // Durable outbox insert INSIDE the transaction (matches deals pattern)
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: DOMAIN_EVENTS.EMAIL_SENT,
        emailId: email.id,
        to,
        subject: subject.trim(),
        dealId: association?.assignedEntityType === "deal" ? association.assignedEntityId : dealId || null,
        contactId: association?.assignedEntityType === "contact" ? association.assignedEntityId : contactId || null,
        assignedEntityType: association?.assignedEntityType ?? null,
        assignedEntityId: association?.assignedEntityId ?? null,
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
          dealId: association?.assignedEntityType === "deal" ? association.assignedEntityId : dealId || null,
          contactId: association?.assignedEntityType === "contact" ? association.assignedEntityId : contactId || null,
          assignedEntityType: association?.assignedEntityType ?? null,
          assignedEntityId: association?.assignedEntityId ?? null,
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
      filter: req.query.filter as "all" | "unread" | "unassigned" | "sent" | undefined,
      status: req.query.status as "unassigned" | "assigned" | "ignored" | "deleted" | undefined,
      search: req.query.search as string | undefined,
      page: parsePaginationParam(req.query.page, "page"),
      limit: parsePaginationParam(req.query.limit, "limit", { max: 100 }),
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
      leadId: deal.sourceLeadId ?? undefined,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      status: req.query.status as "unassigned" | "ignored" | undefined,
      page: parsePaginationParam(req.query.page, "page"),
      limit: parsePaginationParam(req.query.limit, "limit", { defaultValue: 20, max: 100 }),
    };

    const result = await getEmails(req.tenantDb!, filters, undefined, req.user!.role);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/email/:id/ignore — remove irrelevant email from parking-lot assignment intake
router.post("/:id/ignore", async (req, res, next) => {
  try {
    const email = await ignoreEmailAssignment(
      req.tenantDb!,
      req.params.id,
      req.user!.id,
      req.user!.role
    );
    await req.commitTransaction!();
    res.json({ email });
  } catch (err) {
    next(err);
  }
});

// POST /api/email/:id/un-ignore — return ignored email to normal assignment status
router.post("/:id/un-ignore", async (req, res, next) => {
  try {
    const email = await unignoreEmailAssignment(
      req.tenantDb!,
      req.params.id,
      req.user!.id,
      req.user!.role
    );
    await req.commitTransaction!();
    res.json({ email });
  } catch (err) {
    next(err);
  }
});

// GET /api/email/company/:companyId — emails for a specific company
router.get("/company/:companyId", async (req, res, next) => {
  try {
    const company = await getCompanyById(req.tenantDb!, req.params.companyId);
    if (!company) throw new AppError(404, "Company not found");

    const filters = {
      companyId: req.params.companyId,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: parsePaginationParam(req.query.page, "page"),
      limit: parsePaginationParam(req.query.limit, "limit", { defaultValue: 20, max: 100 }),
    };

    const result = await getEmails(req.tenantDb!, filters, undefined, req.user!.role);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/lead/:leadId — emails for a specific lead
// RBAC: verify user has access to this lead before returning emails.
router.get("/lead/:leadId", async (req, res, next) => {
  try {
    const lead = await getLeadById(req.tenantDb!, req.params.leadId, req.user!.role, req.user!.id);
    if (!lead) throw new AppError(404, "Lead not found");

    const filters = {
      leadId: req.params.leadId,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: parsePaginationParam(req.query.page, "page"),
      limit: parsePaginationParam(req.query.limit, "limit", { defaultValue: 20, max: 100 }),
    };

    const result = await getEmails(req.tenantDb!, filters, undefined, req.user!.role);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/contact/:contactId — emails for a specific contact
router.get("/contact/:contactId", async (req, res, next) => {
  try {
    const contact = await getContactById(req.tenantDb!, req.params.contactId);
    if (!contact) throw new AppError(404, "Contact not found");

    const filters = {
      contactId: req.params.contactId,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: parsePaginationParam(req.query.page, "page"),
      limit: parsePaginationParam(req.query.limit, "limit", { defaultValue: 20, max: 100 }),
    };

    const result = await getEmails(req.tenantDb!, filters, undefined, req.user!.role);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/thread/:conversationId — all emails in a thread
router.get("/thread/:conversationId", async (req, res, next) => {
  try {
    const thread = await getEmailThread(
      req.tenantDb!,
      req.params.conversationId,
      req.user!.id,
      req.user!.role,
      (dealId) => canUserViewDeal(req, dealId)
    );
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

    const thread = await getEmailThreadForMutation(req.tenantDb!, req.params.conversationId, req.user!.id);
    await assertCanMutateEmailThread(req.tenantDb!, thread, req.user!);

    const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await bindThreadToDeal(req.tenantDb!, {
      mailboxAccountId: thread.mailboxAccountId,
      providerConversationId: req.params.conversationId,
      dealId,
      actingUserId: req.user!.id,
    });

    const refreshedThread = await getEmailThread(
      req.tenantDb!,
      req.params.conversationId,
      req.user!.id,
      req.user!.role,
      (candidateDealId) => canUserViewDeal(req, candidateDealId)
    );
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

    const thread = await getEmailThreadForMutation(req.tenantDb!, req.params.conversationId, req.user!.id);
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

    const refreshedThread = await getEmailThread(
      req.tenantDb!,
      req.params.conversationId,
      req.user!.id,
      req.user!.role,
      (candidateDealId) => canUserViewDeal(req, candidateDealId)
    );
    await req.commitTransaction!();
    res.json({ ...result, preview, thread: refreshedThread });
  } catch (err) {
    next(err);
  }
});

router.post("/thread/:conversationId/detach", async (req, res, next) => {
  try {
    const thread = await getEmailThreadForMutation(req.tenantDb!, req.params.conversationId, req.user!.id);
    await assertCanMutateEmailThread(req.tenantDb!, thread, req.user!);

    await detachThreadByConversation(req.tenantDb!, thread.mailboxAccountId, req.params.conversationId, req.user!.id);
    const refreshedThread = await getEmailThread(
      req.tenantDb!,
      req.params.conversationId,
      req.user!.id,
      req.user!.role,
      (candidateDealId) => canUserViewDeal(req, candidateDealId)
    );
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
      status: req.query.status as "unassigned" | "ignored" | undefined,
      page: parsePaginationParam(req.query.page, "page"),
      limit: parsePaginationParam(req.query.limit, "limit", { max: 100 }),
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

// PATCH /api/email/:id/actions — inbox reader actions (star, archive, soft-delete)
router.patch("/:id/actions", async (req, res, next) => {
  try {
    const body = req.body as {
      isStarred?: boolean;
      archived?: boolean;
      deleted?: boolean;
    };

    const hasValidAction =
      typeof body.isStarred === "boolean" ||
      typeof body.archived === "boolean" ||
      typeof body.deleted === "boolean";
    if (!hasValidAction) {
      throw new AppError(400, "At least one email action is required");
    }

    const email = await updateEmailInboxAction(
      req.tenantDb!,
      req.params.id,
      req.user!.id,
      req.user!.role,
      {
        isStarred: typeof body.isStarred === "boolean" ? body.isStarred : undefined,
        archived: typeof body.archived === "boolean" ? body.archived : undefined,
        deleted: typeof body.deleted === "boolean" ? body.deleted : undefined,
      }
    );
    await req.commitTransaction!();
    res.json({ email });
  } catch (err) {
    next(err);
  }
});

// GET /api/email/:id — single email with full body
// Security: mailbox data is visible to the owner, or to teammates when it has
// been explicitly assigned to an entity the viewer can access.
router.get("/:id", async (req, res, next) => {
  try {
    const email = await getEmailById(req.tenantDb!, req.params.id);
    if (!email) throw new AppError(404, "Email not found");

    const ownsEmail = email.userId === req.user!.id;
    const isSharedEmailActive =
      email.archivedAt == null &&
      email.deletedAt == null &&
      email.assignmentStatus !== "ignored";
    const hasAssignedEntityAccess = ownsEmail
      ? true
      : isSharedEmailActive &&
        await canUserViewAssignedEmailEntity(req, email.assignedEntityType, email.assignedEntityId);

    if (!hasAssignedEntityAccess) {
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
    const association = parseRequestedEmailAssociation(req.body);
    if (!association) {
      throw new AppError(400, "assignedEntityId is required");
    }

    // Verify the email exists and the user has permission to modify it
    const email = await getEmailById(req.tenantDb!, req.params.id);
    if (!email) throw new AppError(404, "Email not found");

    if (email.userId !== req.user!.id) {
      throw new AppError(403, "You do not have permission to modify this email");
    }

    await assertRequestedAssociationExists(req, association);

    await associateEmailToEntity(
      req.tenantDb!,
      req.params.id,
      {
        assignedEntityType: association.assignedEntityType,
        assignedEntityId: association.assignedEntityId,
        assignedDealId: association.assignedDealId,
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
