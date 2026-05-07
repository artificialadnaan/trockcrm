// server/src/modules/migration/routes.ts

import { Router, type NextFunction, type Request, type Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { requireAdmin } from "../../middleware/rbac.js";
import {
  getMigrationSummary,
  getMigrationExceptions,
  getImportRuns,
  createImportRun,
  completeImportRun,
  listStagedCompanies,
  approveStagedCompany,
  rejectStagedCompany,
  listStagedProperties,
  approveStagedProperty,
  rejectStagedProperty,
  listStagedLeads,
  approveStagedLead,
  rejectStagedLead,
  listStagedDeals,
  approveStagedDeal,
  rejectStagedDeal,
  batchApproveStagedDeals,
  listStagedContacts,
  approveStagedContact,
  rejectStagedContact,
  mergeStagedContact,
  batchApproveStagedContacts,
} from "./service.js";
import {
  validateStagedDeals,
  validateStagedContacts,
  validateStagedActivities,
  validateStagedCompanies,
  validateStagedProperties,
  validateStagedLeads,
} from "./validator.js";

const router = Router();
// Restrict admin gating to actual migration endpoints so unrelated /api/* routes
// mounted after this router are not intercepted for non-admin users.
router.use("/migration", authMiddleware, requireAdmin);

// ---------------------------------------------------------------------------
// Dashboard
// GET /api/migration/summary
// ---------------------------------------------------------------------------

router.get("/migration/summary", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await getMigrationSummary();
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Exception review
// GET /api/migration/exceptions
// ---------------------------------------------------------------------------

router.get("/migration/exceptions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const exceptions = await getMigrationExceptions();
    return res.json(exceptions);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Import run history
// GET /api/migration/runs
// ---------------------------------------------------------------------------

router.get("/migration/runs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const runs = await getImportRuns();
    return res.json({ runs });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Trigger validation
// POST /api/migration/validate
// ---------------------------------------------------------------------------

router.post("/migration/validate", async (req: Request, res: Response, next: NextFunction) => {
  const runRow = await createImportRun("validate", req.user!.id);
  try {
    const [
      dealResults,
      contactResults,
      activityResults,
      companyResults,
      propertyResults,
      leadResults,
    ] = await Promise.all([
      validateStagedDeals(),
      validateStagedContacts(),
      validateStagedActivities(),
      validateStagedCompanies(),
      validateStagedProperties(),
      validateStagedLeads(),
    ]);

    const stats = {
      deals: dealResults,
      contacts: contactResults,
      activities: activityResults,
      companies: companyResults,
      properties: propertyResults,
      leads: leadResults,
    } as const;

    await completeImportRun(runRow.id, stats);
    return res.json({ runId: runRow.id, stats });
  } catch (err) {
    await completeImportRun(runRow.id, {}, String(err));
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Staged companies
// GET /api/migration/companies?validationStatus=invalid&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/companies", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedCompanies({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/companies/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await approveStagedCompany(req.params.id as string, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/companies/:id/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedCompany(req.params.id as string, req.user!.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Staged properties
// GET /api/migration/properties?validationStatus=invalid&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/properties", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedProperties({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/properties/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await approveStagedProperty(req.params.id as string, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/properties/:id/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedProperty(req.params.id as string, req.user!.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Staged leads
// GET /api/migration/leads?validationStatus=invalid&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/leads", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedLeads({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/leads/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await approveStagedLead(req.params.id as string, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/leads/:id/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedLead(req.params.id as string, req.user!.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Staged deals
// GET /api/migration/deals?validationStatus=invalid&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/deals", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedDeals({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// POST /api/migration/deals/:id/approve
router.post("/migration/deals/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await approveStagedDeal(req.params.id as string, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/migration/deals/:id/reject
router.post("/migration/deals/:id/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedDeal(req.params.id as string, req.user!.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/migration/deals/batch-approve
router.post("/migration/deals/batch-approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: { message: "ids array required" } });
    }
    const count = await batchApproveStagedDeals(ids, req.user!.id);
    return res.json({ approved: count });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Staged contacts
// GET /api/migration/contacts?validationStatus=duplicate&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/contacts", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedContacts({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/contacts/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await approveStagedContact(req.params.id as string, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/contacts/:id/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedContact(req.params.id as string, req.user!.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/contacts/:id/merge", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { mergeTargetId } = req.body as { mergeTargetId: string };
    if (!mergeTargetId) return res.status(400).json({ error: { message: "mergeTargetId required" } });
    await mergeStagedContact(req.params.id as string, mergeTargetId, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/migration/contacts/batch-approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: { message: "ids array required" } });
    }
    const count = await batchApproveStagedContacts(ids, req.user!.id);
    return res.json({ approved: count });
  } catch (err) {
    return next(err);
  }
});

export { router as migrationRouter };
