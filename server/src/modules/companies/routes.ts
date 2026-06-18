import { Router } from "express";
import {
  listCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
  getCompanyContacts,
  getCompanyDeals,
  getCompanyStats,
  searchCompanies,
} from "./service.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { requestAuditContext, writeSoftDeleteAuditLog } from "../../lib/soft-delete-audit.js";
import { markCompanyRejected, markCompanyVerified } from "./customer-status-service.js";
import { assignCompanyOwnerToSelf, reassignCompanyOwner } from "../ownership/assignment-service.js";

const router = Router();

// GET /companies/search?q=greystar — autocomplete for dropdowns
router.get("/search", async (req, res, next) => {
  try {
    const q = (req.query.q as string) || "";
    const results = await searchCompanies(req.tenantDb!, q);
    await req.commitTransaction!();
    res.json({ companies: results });
  } catch (err) { next(err); }
});

// GET /companies — list with search, filter, pagination
router.get("/", async (req, res, next) => {
  try {
    const { search, category, industry, ownerScope, hasActivePipeline, stale, page, limit } = req.query as Record<string, string>;
    const result = await listCompanies(req.tenantDb!, {
      search,
      category,
      industry,
      ownerUserId: ownerScope === "mine" ? req.user!.id : undefined,
      // Summary-card drill-downs (?card=pipeline / ?card=stale on the companies page).
      hasActivePipeline: hasActivePipeline === "true" ? true : undefined,
      stale: stale === "true" ? true : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) { next(err); }
});

// GET /companies/:id
router.get("/:id", async (req, res, next) => {
  try {
    const company = await getCompanyById(req.tenantDb!, req.params.id);
    if (!company) throw new AppError(404, "Company not found");
    const stats = await getCompanyStats(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ company: { ...company, ...stats } });
  } catch (err) { next(err); }
});

// POST /companies
router.post("/", async (req, res, next) => {
  try {
    const { name, category, address, city, state, zip, phone, website, notes, skipDedupCheck } = req.body;
    if (!name) throw new AppError(400, "Company name is required");
    const { company, dedupResult } = await createCompany(
      req.tenantDb!,
      { name, category: category || "other", address, city, state, zip, phone, website, notes },
      skipDedupCheck === true
    );

    // Likely duplicate found (no hard block): return the matches so the client can
    // warn and let the rep pick the existing company or create anyway.
    if (!company && dedupResult) {
      await req.commitTransaction!();
      res.status(200).json({ company: null, dedupWarning: true, suggestions: dedupResult.suggestions });
      return;
    }

    await req.commitTransaction!();
    res.status(201).json({ company });
  } catch (err) { next(err); }
});

// PATCH /companies/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const company = await updateCompany(req.tenantDb!, req.params.id, req.body);
    if (!company) throw new AppError(404, "Company not found");
    await req.commitTransaction!();
    res.json({ company });
  } catch (err) { next(err); }
});

// POST /companies/:id/assign-to-me — any CRM user may claim an unassigned company
router.post("/:id/assign-to-me", async (req, res, next) => {
  try {
    const company = await assignCompanyOwnerToSelf(req.tenantDb!, req.params.id, {
      id: req.user!.id,
      role: req.user!.role,
      activeOfficeId: req.user!.activeOfficeId,
      officeId: req.user!.officeId,
    });
    await req.commitTransaction!();
    res.json({ company });
  } catch (err) { next(err); }
});

// PATCH /companies/:id/owner — admin/director reassignment, including clearing owner
router.patch("/:id/owner", async (req, res, next) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, "ownerUserId")) {
      throw new AppError(400, "ownerUserId is required");
    }
    const ownerUserId = req.body.ownerUserId;
    if (ownerUserId !== null && typeof ownerUserId !== "string") {
      throw new AppError(400, "ownerUserId must be a user id or null");
    }

    const company = await reassignCompanyOwner(req.tenantDb!, req.params.id, ownerUserId, {
      id: req.user!.id,
      role: req.user!.role,
      activeOfficeId: req.user!.activeOfficeId,
      officeId: req.user!.officeId,
    });
    await req.commitTransaction!();
    res.json({ company });
  } catch (err) { next(err); }
});

// DELETE /companies/:id — admin-only soft-delete
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const companyId = req.params.id as string;
    const company = await deleteCompany(req.tenantDb!, companyId);
    if (company) {
      await writeSoftDeleteAuditLog(req.tenantDb!, {
        actorUserId: req.user!.id,
        entityType: "company",
        entityId: companyId,
        ...requestAuditContext(req),
      });
    }
    await req.commitTransaction!();
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /companies/:id/verify
router.post("/:id/verify", async (req, res, next) => {
  try {
    if (req.user!.role !== "admin" && req.user!.role !== "director") {
      throw new AppError(403, "Only directors and admins can verify companies");
    }

    const company = await markCompanyVerified(req.tenantDb!, {
      companyId: req.params.id,
      userId: req.user!.id,
    });
    if (!company) throw new AppError(404, "Company not found");
    await req.commitTransaction!();
    res.json({ company });
  } catch (err) { next(err); }
});

// POST /companies/:id/reject
router.post("/:id/reject", async (req, res, next) => {
  try {
    if (req.user!.role !== "admin" && req.user!.role !== "director") {
      throw new AppError(403, "Only directors and admins can reject company verification");
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    const company = await markCompanyRejected(req.tenantDb!, {
      companyId: req.params.id,
      userId: req.user!.id,
      reason,
    });
    if (!company) throw new AppError(404, "Company not found");
    await req.commitTransaction!();
    res.json({ company });
  } catch (err) { next(err); }
});

// GET /companies/:id/contacts
router.get("/:id/contacts", async (req, res, next) => {
  try {
    const list = await getCompanyContacts(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ contacts: list });
  } catch (err) { next(err); }
});

// GET /companies/:id/deals
router.get("/:id/deals", async (req, res, next) => {
  try {
    const list = await getCompanyDeals(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ deals: list });
  } catch (err) { next(err); }
});

export const companyRoutes = router;
