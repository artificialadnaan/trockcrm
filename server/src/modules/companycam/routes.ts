/**
 * CompanyCam API routes.
 * All routes are tenant-scoped and require admin/director role.
 * Sync operations run in the background with a dedicated DB connection.
 */

import { Router } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getProjectMappings,
  linkProjectToDeal,
  unlinkProject,
  syncProjectPhotos,
  syncAllLinkedProjects,
  autoLinkAndSync,
} from "./service.js";

const router = Router();

// Input validation helpers
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CC_PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;

function validateDealId(id: string): void {
  if (!UUID_RE.test(id)) throw new AppError(400, "Invalid dealId format.");
}

function validateCcProjectId(id: string): void {
  if (!CC_PROJECT_ID_RE.test(id)) throw new AppError(400, "Invalid ccProjectId format.");
}

// In-memory sync status (single-instance Railway deployment)
// The `running` flag is set synchronously before any async work to prevent races.
let syncStatus: {
  running: boolean;
  startedAt: Date | null;
  progress: string;
  results: unknown[] | null;
  error: string | null;
} = { running: false, startedAt: null, progress: "", results: null, error: null };

function requireAdminOrDirector(role: string): void {
  if (role !== "admin" && role !== "director") {
    throw new AppError(403, "CompanyCam management requires admin or director role.");
  }
}

/**
 * Acquire a fresh tenant-scoped DB connection for background work.
 * The returned client MUST be released in a finally block.
 */
async function acquireBackgroundDb(officeSlug: string) {
  const client = await pool.connect();
  const schemaName = `office_${officeSlug}`;
  await client.query("SELECT set_config('search_path', $1, false)", [`${schemaName}, public`]);
  const tenantDb = drizzle(client, { schema });
  return { tenantDb, release: () => client.release() };
}

// GET /api/companycam/mappings — Get all CC projects with deal match status
router.get("/mappings", async (req, res, next) => {
  try {
    requireAdminOrDirector(req.user!.role);
    const mappings = await getProjectMappings(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ mappings });
  } catch (err) {
    next(err);
  }
});

// GET /api/companycam/sync-status — Check background sync progress
router.get("/sync-status", async (req, res, next) => {
  try {
    requireAdminOrDirector(req.user!.role);
    await req.commitTransaction!();
    res.json(syncStatus);
  } catch (err) {
    next(err);
  }
});

// POST /api/companycam/link — Link a CC project to a deal
router.post("/link", async (req, res, next) => {
  try {
    requireAdminOrDirector(req.user!.role);
    const { ccProjectId, dealId } = req.body;
    if (!ccProjectId || !dealId) {
      throw new AppError(400, "ccProjectId and dealId are required.");
    }
    validateCcProjectId(ccProjectId);
    validateDealId(dealId);
    await linkProjectToDeal(req.tenantDb!, ccProjectId, dealId);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/companycam/unlink — Unlink a CC project from its deal
router.post("/unlink", async (req, res, next) => {
  try {
    requireAdminOrDirector(req.user!.role);
    const { ccProjectId } = req.body;
    if (!ccProjectId) {
      throw new AppError(400, "ccProjectId is required.");
    }
    validateCcProjectId(ccProjectId);
    await unlinkProject(req.tenantDb!, ccProjectId);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/companycam/sync/:projectId — Sync photos for a single linked project (background)
router.post("/sync/:projectId", async (req, res, next) => {
  try {
    requireAdminOrDirector(req.user!.role);
    validateCcProjectId(req.params.projectId);

    // Synchronous guard — set before any await to prevent race conditions
    if (syncStatus.running) {
      throw new AppError(409, "A sync is already in progress. Check /sync-status for updates.");
    }
    syncStatus = { running: true, startedAt: new Date(), progress: `Syncing project ${req.params.projectId}...`, results: null, error: null };

    const projectId = req.params.projectId;
    const userId = req.user!.id;
    const officeSlug = req.officeSlug!;

    // Commit the request transaction — we'll use a dedicated connection for background work
    await req.commitTransaction!();
    res.json({ message: "Sync started in background. Poll /sync-status for progress." });

    // Acquire a fresh DB connection for background work
    const { tenantDb: bgDb, release } = await acquireBackgroundDb(officeSlug);
    syncProjectPhotos(bgDb, projectId, userId, officeSlug, (progress) => {
      syncStatus.progress = progress;
    })
      .then((result) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Complete", results: [result], error: null };
      })
      .catch((err) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() => release());
  } catch (err) {
    if (syncStatus.running && !syncStatus.results && !syncStatus.error) {
      syncStatus.running = false;
    }
    next(err);
  }
});

// POST /api/companycam/sync-all — Sync photos for all linked projects (background)
router.post("/sync-all", async (req, res, next) => {
  try {
    requireAdminOrDirector(req.user!.role);

    if (syncStatus.running) {
      throw new AppError(409, "A sync is already in progress. Check /sync-status for updates.");
    }
    syncStatus = { running: true, startedAt: new Date(), progress: "Syncing all linked projects...", results: null, error: null };

    const userId = req.user!.id;
    const officeSlug = req.officeSlug!;

    await req.commitTransaction!();
    res.json({ message: "Sync started in background. Poll /sync-status for progress." });

    const { tenantDb: bgDb, release } = await acquireBackgroundDb(officeSlug);
    syncAllLinkedProjects(bgDb, userId, officeSlug, (progress) => {
      syncStatus.progress = progress;
    })
      .then((results) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Complete", results, error: null };
      })
      .catch((err) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() => release());
  } catch (err) {
    if (syncStatus.running && !syncStatus.results && !syncStatus.error) {
      syncStatus.running = false;
    }
    next(err);
  }
});

// POST /api/companycam/auto-import — Auto-link by name match + sync everything (background)
router.post("/auto-import", async (req, res, next) => {
  try {
    requireAdminOrDirector(req.user!.role);

    if (syncStatus.running) {
      throw new AppError(409, "A sync is already in progress. Check /sync-status for updates.");
    }
    syncStatus = { running: true, startedAt: new Date(), progress: "Auto-linking projects and syncing photos...", results: null, error: null };

    const userId = req.user!.id;
    const officeSlug = req.officeSlug!;

    await req.commitTransaction!();
    res.json({ message: "Auto-import started in background. Poll /sync-status for progress." });

    const { tenantDb: bgDb, release } = await acquireBackgroundDb(officeSlug);
    autoLinkAndSync(bgDb, userId, officeSlug, (progress) => {
      syncStatus.progress = progress;
    })
      .then(({ linked, results }) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: `Complete — ${linked} projects linked`, results, error: null };
      })
      .catch((err) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() => release());
  } catch (err) {
    if (syncStatus.running && !syncStatus.results && !syncStatus.error) {
      syncStatus.running = false;
    }
    next(err);
  }
});

export const companycamRoutes = router;
