/**
 * CompanyCam API routes.
 * All routes are tenant-scoped and require admin/director role.
 * Sync operations run in the background with a dedicated DB connection.
 */

import { Router } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool, releasePooledClient, isBrokenConnectionError } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getProjectMappings,
  linkProjectToDeal,
  unlinkProject,
  syncProjectPhotos,
  syncAllLinkedProjects,
  autoLinkProjects,
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
  try {
    // Use a transaction-local search_path (true = transaction-local, not session-local)
    // so concurrent requests on other connections are not affected.
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
  } catch (err) {
    // Setup failed (e.g. a stale checked-out socket now rejecting with Query read timeout) BEFORE we could
    // return the release handle — release/destroy the client here so the caller can't leak this pool slot.
    releasePooledClient(client, err);
    throw err;
  }
  const tenantDb = drizzle(client, { schema });
  return {
    tenantDb,
    release: async (rollback = false, opErr?: unknown) => {
      // opErr = the caller's operation error (the reason for the rollback). Seed releaseErr with it so a
      // broken operation is destroyed even if the ROLLBACK below reports success.
      let releaseErr: unknown = opErr;
      try {
        if (rollback) {
          // Skip ROLLBACK on an already-dead socket (it would burn another query_timeout) — opErr already
          // marks the client for destruction. Otherwise roll back, letting a failed rollback win.
          if (!isBrokenConnectionError(opErr)) {
            await client.query("ROLLBACK").catch((rollbackErr) => {
              releaseErr = rollbackErr ?? opErr;
            });
          }
        } else {
          // Propagate COMMIT failures (fail-closed): a failed commit must be treated as a failure, never
          // swallowed and reported as success. Callers translate the throw into a Failed sync status.
          await client.query("COMMIT");
        }
      } catch (err) {
        releaseErr = err;
        throw err;
      } finally {
        // Always return the connection to the pool, even when COMMIT throws, to avoid leaking it.
        // Route through releasePooledClient so a broken connection (COMMIT/ROLLBACK on a dead
        // socket) is destroyed instead of recycled back into the idle pool.
        releasePooledClient(client, releaseErr);
      }
    },
  };
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
    let syncFailed = false;
    let syncErr: unknown;
    syncProjectPhotos(bgDb, projectId, userId, officeSlug, (progress) => {
      syncStatus.progress = progress;
    })
      .then((result) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Complete", results: [result], error: null };
      })
      .catch((err) => {
        syncFailed = true;
        syncErr = err; // pass the actual error to release() so a dead-socket sync failure destroys the client
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() =>
        // release() now THROWS on a failed COMMIT; treat that as a sync failure (fail-closed) instead of
        // letting it surface as an unhandled rejection or leave a "Complete" status standing after a bad commit.
        release(syncFailed, syncErr).catch((err) => {
          syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
        }),
      );
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
    let syncAllFailed = false;
    let syncAllErr: unknown;
    syncAllLinkedProjects(bgDb, userId, officeSlug, (progress) => {
      syncStatus.progress = progress;
    })
      .then((results) => {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Complete", results, error: null };
      })
      .catch((err) => {
        syncAllFailed = true;
        syncAllErr = err; // pass the actual error to release() so a dead-socket sync failure destroys the client
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() =>
        // release() now THROWS on a failed COMMIT; treat that as a sync failure (fail-closed) instead of
        // letting it surface as an unhandled rejection or leave a "Complete" status standing after a bad commit.
        release(syncAllFailed, syncAllErr).catch((err) => {
          syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
        }),
      );
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

    // Two-phase background flow. autoLinkProjects takes a per-project advisory lock for each link; running
    // it in its OWN transaction and COMMITting BEFORE the long photo sync RELEASES those locks promptly, so
    // a concurrent link/assign of the same project isn't blocked through the whole sync (and its statement
    // timeout). Semantic change (acceptable/better): the links commit independently of the sync, so a sync
    // failure leaves the links persisted — they sync on the next run. acquireBackgroundDb re-applies the
    // transaction-local search_path each time, so the sync phase stays correctly tenant-scoped.
    void (async () => {
      // Fail-closed wrapper: ANY failure below (acquireBackgroundDb throwing, a phase throwing, or a
      // release/COMMIT throwing) lands in this single catch and sets running:false + an error. The IIFE can
      // NEVER leave syncStatus stuck at running:true, and the "Complete" status is only ever set AFTER the
      // phase-2 COMMIT succeeds — so a failed commit is never reported as success.
      try {
        // Phase 1 — LINK ONLY, in its own transaction; COMMIT releases the per-project advisory locks.
        let linked = 0;
        {
          const { tenantDb: linkDb, release } = await acquireBackgroundDb(officeSlug);
          try {
            linked = await autoLinkProjects(linkDb, (progress) => {
              syncStatus.progress = progress;
            });
          } catch (err) {
            await release(true, err); // ROLLBACK this phase's connection (or destroy it if err broke it), then fail
            throw err;
          }
          // COMMIT is OUTSIDE the inner try so a COMMIT failure isn't double-released by the catch's
          // ROLLBACK (release() already returned the connection); it propagates to the outer catch instead.
          await release(); // COMMIT — frees the advisory locks before the sync starts
        }

        // Phase 2 — PHOTO SYNC, in a FRESH transaction (no link locks held). Reached ONLY after phase 1's
        // acquire + COMMIT both succeeded.
        {
          const { tenantDb: syncDb, release } = await acquireBackgroundDb(officeSlug);
          let results: Awaited<ReturnType<typeof syncAllLinkedProjects>>;
          try {
            results = await syncAllLinkedProjects(syncDb, userId, officeSlug, (progress) => {
              syncStatus.progress = progress;
            });
          } catch (err) {
            await release(true, err); // ROLLBACK this phase's connection (or destroy it if err broke it), then fail
            throw err;
          }
          await release(); // COMMIT — a commit failure propagates to the outer catch (never reports Complete)
          syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: `Complete — ${linked} projects linked`, results, error: null };
        }
      } catch (err) {
        syncStatus = { running: false, startedAt: syncStatus.startedAt, progress: "Failed", results: null, error: err instanceof Error ? err.message : String(err) };
      }
    })();
  } catch (err) {
    if (syncStatus.running && !syncStatus.results && !syncStatus.error) {
      syncStatus.running = false;
    }
    next(err);
  }
});

export const companycamRoutes = router;
