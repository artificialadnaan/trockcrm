// server/src/modules/migration/routes.ts

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { requireAdmin } from "../../middleware/rbac.js";
import {
  getMigrationSummary,
  getImportRuns,
  createImportRun,
  completeImportRun,
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
} from "./validator.js";

const router = Router();
router.use(authMiddleware, requireAdmin);

// ---------------------------------------------------------------------------
// Dashboard
// GET /api/migration/summary
// ---------------------------------------------------------------------------

router.get("/migration/summary", async (req: Request, res: Response) => {
  try {
    const summary = await getMigrationSummary();
    return res.json(summary);
  } catch (err) {
    console.error("[migration] summary error:", err);
    return res.status(500).json({ error: { message: String(err) } });
  }
});

// ---------------------------------------------------------------------------
// Import run history
// GET /api/migration/runs
// ---------------------------------------------------------------------------

router.get("/migration/runs", async (req: Request, res: Response) => {
  try {
    const runs = await getImportRuns();
    return res.json({ runs });
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

// ---------------------------------------------------------------------------
// Trigger validation
// POST /api/migration/validate
// ---------------------------------------------------------------------------

router.post("/migration/validate", async (req: Request, res: Response) => {
  const runRow = await createImportRun("validate", req.user!.id);
  try {
    const [dealResults, contactResults, activityResults] = await Promise.all([
      validateStagedDeals(),
      validateStagedContacts(),
      validateStagedActivities(),
    ]);

    const stats = {
      deals: dealResults,
      contacts: contactResults,
      activities: activityResults,
    };

    await completeImportRun(runRow.id, stats);
    return res.json({ runId: runRow.id, stats });
  } catch (err) {
    await completeImportRun(runRow.id, {}, String(err));
    return res.status(500).json({ error: { message: String(err) } });
  }
});

// ---------------------------------------------------------------------------
// Staged deals
// GET /api/migration/deals?validationStatus=invalid&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/deals", async (req: Request, res: Response) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedDeals({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

// POST /api/migration/deals/:id/approve
router.post("/migration/deals/:id/approve", async (req: Request, res: Response) => {
  try {
    await approveStagedDeal(req.params.id as string, req.user!.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
  }
});

// POST /api/migration/deals/:id/reject
router.post("/migration/deals/:id/reject", async (req: Request, res: Response) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedDeal(req.params.id as string, req.user!.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

// POST /api/migration/deals/batch-approve
router.post("/migration/deals/batch-approve", async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: { message: "ids array required" } });
    }
    const count = await batchApproveStagedDeals(ids, req.user!.id);
    return res.json({ approved: count });
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

// ---------------------------------------------------------------------------
// Staged contacts
// GET /api/migration/contacts?validationStatus=duplicate&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/contacts", async (req: Request, res: Response) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedContacts({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

router.post("/migration/contacts/:id/approve", async (req: Request, res: Response) => {
  try {
    await approveStagedContact(req.params.id as string, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

router.post("/migration/contacts/:id/reject", async (req: Request, res: Response) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedContact(req.params.id as string, req.user!.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

router.post("/migration/contacts/:id/merge", async (req: Request, res: Response) => {
  try {
    const { mergeTargetId } = req.body as { mergeTargetId: string };
    if (!mergeTargetId) return res.status(400).json({ error: { message: "mergeTargetId required" } });
    await mergeStagedContact(req.params.id as string, mergeTargetId, req.user!.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

router.post("/migration/contacts/batch-approve", async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: { message: "ids array required" } });
    }
    const count = await batchApproveStagedContacts(ids, req.user!.id);
    return res.json({ approved: count });
  } catch (err) {
    return res.status(500).json({ error: { message: String(err) } });
  }
});

export { router as migrationRouter };
