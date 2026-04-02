import { Router } from "express";
import { eq } from "drizzle-orm";
import { contactDealAssociations, jobQueue } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import {
  getContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  checkForDuplicates,
  getContactsNeedingOutreach,
  getCompanyNames,
} from "./service.js";
import { searchContacts } from "./search-service.js";
import {
  getDealsForContact,
  createAssociation,
  updateAssociation,
  deleteAssociation,
} from "./association-service.js";
import {
  getDuplicateQueue,
  mergeContacts,
  dismissDuplicate,
} from "./merge-service.js";
import { getDealById } from "../deals/service.js";

const router = Router();

// GET /api/contacts — list contacts (paginated, filtered, sorted)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      category: req.query.category as string | undefined,
      companyName: req.query.companyName as string | undefined,
      city: req.query.city as string | undefined,
      state: req.query.state as string | undefined,
      isActive: req.query.isActive === "false" ? false : true,
      hasOutreach: req.query.hasOutreach === "true"
        ? true
        : req.query.hasOutreach === "false"
          ? false
          : undefined,
      sortBy: req.query.sortBy as any,
      sortDir: req.query.sortDir as "asc" | "desc" | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getContacts(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/companies — distinct company names for filter dropdown
router.get("/companies", async (req, res, next) => {
  try {
    const companies = await getCompanyNames(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/needs-outreach — contacts without first outreach
router.get("/needs-outreach", async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const contactList = await getContactsNeedingOutreach(req.tenantDb!, limit);
    await req.commitTransaction!();
    res.json({ contacts: contactList });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/dedup-check — check for duplicates without creating
router.post("/dedup-check", async (req, res, next) => {
  try {
    const { firstName, lastName, email, companyName } = req.body;
    if (!firstName || !lastName) {
      throw new AppError(400, "firstName and lastName are required");
    }

    const result = await checkForDuplicates(req.tenantDb!, {
      firstName,
      lastName,
      email,
      companyName,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/search?q=... — fast autocomplete search
// MUST be registered BEFORE /:id to avoid "search" being caught as an ID param
router.get("/search", async (req, res, next) => {
  try {
    const query = req.query.q as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

    const results = await searchContacts(req.tenantDb!, query ?? "", limit);
    await req.commitTransaction!();
    res.json({ contacts: results });
  } catch (err) {
    next(err);
  }
});

// --- Duplicate Queue & Merge ---

// GET /api/contacts/duplicates — duplicate queue (director/admin only)
router.get("/duplicates", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const filters = {
      status: req.query.status as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };
    const result = await getDuplicateQueue(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/duplicates/:id/merge — merge two contacts (director/admin only)
router.post(
  "/duplicates/:id/merge",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const { winnerId, loserId } = req.body;
      if (!winnerId || !loserId) {
        throw new AppError(400, "winnerId and loserId are required");
      }

      const result = await mergeContacts(
        req.tenantDb!,
        winnerId,
        loserId,
        req.user!.id,
        req.params.id as string
      );

      await req.commitTransaction!();
      res.json({ merge: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/contacts/duplicates/:id/dismiss — dismiss a duplicate (director/admin only)
router.post(
  "/duplicates/:id/dismiss",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const entry = await dismissDuplicate(req.tenantDb!, req.params.id as string, req.user!.id);
      await req.commitTransaction!();
      res.json({ entry });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/contacts/:id — single contact
router.get("/:id", async (req, res, next) => {
  try {
    const contact = await getContactById(req.tenantDb!, req.params.id);
    if (!contact) throw new AppError(404, "Contact not found");
    await req.commitTransaction!();
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts — create a new contact
router.post("/", async (req, res, next) => {
  try {
    const { firstName, lastName, skipDedupCheck, ...rest } = req.body;
    if (!firstName || !lastName) {
      throw new AppError(400, "firstName and lastName are required");
    }
    if (!rest.category) {
      throw new AppError(400, "category is required");
    }

    const { contact, dedupResult } = await createContact(
      req.tenantDb!,
      { firstName, lastName, ...rest },
      skipDedupCheck === true
    );

    // If dedup returned fuzzy suggestions (no hard block), return them
    // so the frontend can show the warning and let the user decide
    if (!contact && dedupResult) {
      await req.commitTransaction!();
      res.status(200).json({
        contact: null,
        dedupWarning: true,
        suggestions: dedupResult.fuzzySuggestions,
      });
      return;
    }

    // Durable outbox insert INSIDE the transaction (matches deals pattern)
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: DOMAIN_EVENTS.CONTACT_CREATED,
        contactId: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        companyName: contact.companyName,
        category: contact.category,
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
        name: DOMAIN_EVENTS.CONTACT_CREATED,
        payload: {
          contactId: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          companyName: contact.companyName,
          category: contact.category,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Contacts] Failed to emit contact.created local event:", eventErr);
    }

    res.status(201).json({ contact });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/:id — update contact fields
router.patch("/:id", async (req, res, next) => {
  try {
    const contact = await updateContact(req.tenantDb!, req.params.id, req.body);
    await req.commitTransaction!();
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id — soft-delete (director/admin only)
router.delete("/:id", requireRole("admin", "director"), async (req, res, next) => {
  try {
    await deleteContact(req.tenantDb!, req.params.id as string, req.user!.role);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Contact-Deal Associations ---

// GET /api/contacts/:id/deals — deals associated with a contact
router.get("/:id/deals", async (req, res, next) => {
  try {
    const contact = await getContactById(req.tenantDb!, req.params.id);
    if (!contact) throw new AppError(404, "Contact not found");

    const associations = await getDealsForContact(req.tenantDb!, req.params.id, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ associations });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/:id/deals — associate contact with a deal
router.post("/:id/deals", async (req, res, next) => {
  try {
    const { dealId, role, isPrimary } = req.body;
    if (!dealId) throw new AppError(400, "dealId is required");

    // RBAC: verify the requesting user has access to this deal
    const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found or access denied");

    const association = await createAssociation(req.tenantDb!, {
      contactId: req.params.id,
      dealId,
      role,
      isPrimary,
    });

    await req.commitTransaction!();
    res.status(201).json({ association });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/associations/:associationId — update association
router.patch("/associations/:associationId", async (req, res, next) => {
  try {
    // RBAC: fetch the association first so we can verify deal access
    const [existing] = await req.tenantDb!
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, req.params.associationId))
      .limit(1);
    if (!existing) throw new AppError(404, "Association not found");

    const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(403, "Access denied to the associated deal");

    const association = await updateAssociation(
      req.tenantDb!,
      req.params.associationId,
      req.body
    );
    await req.commitTransaction!();
    res.json({ association });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/associations/:associationId — remove association
router.delete("/associations/:associationId", async (req, res, next) => {
  try {
    // RBAC: fetch the association first so we can verify deal access
    const [existing] = await req.tenantDb!
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, req.params.associationId))
      .limit(1);
    if (!existing) throw new AppError(404, "Association not found");

    const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(403, "Access denied to the associated deal");

    await deleteAssociation(req.tenantDb!, req.params.associationId);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const contactRoutes = router;
