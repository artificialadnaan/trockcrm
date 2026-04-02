// server/src/modules/procore/routes.ts
// Procore-specific API routes under /api/procore (tenant-scoped, auth required).

import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { procoreSyncState } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { db } from "../../db.js";
import { procoreClient } from "../../lib/procore-client.js";

const router = Router();

// GET /api/procore/sync-status — admin overview
router.get(
  "/sync-status",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const [summary, conflicts] = await Promise.all([
        db.execute<{ sync_status: string; count: string }>(sql`
          SELECT sync_status, COUNT(*) as count
          FROM public.procore_sync_state
          GROUP BY sync_status
        `),
        db
          .select()
          .from(procoreSyncState)
          .where(eq(procoreSyncState.syncStatus, "conflict"))
          .orderBy(procoreSyncState.updatedAt),
      ]);

      const summaryMap: Record<string, number> = {
        synced: 0,
        pending: 0,
        conflict: 0,
        error: 0,
      };
      for (const row of summary.rows as any[]) {
        summaryMap[row.sync_status] = parseInt(row.count, 10);
      }

      await req.commitTransaction!();
      res.json({
        summary: summaryMap,
        conflicts,
        circuit_breaker: procoreClient.getCircuitState(),
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/procore/sync-conflicts/:id/resolve — admin manually resolves conflict
router.post(
  "/sync-conflicts/:id/resolve",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { resolution } = req.body;
      if (!resolution || !["accept_crm", "accept_procore"].includes(resolution)) {
        throw new AppError(400, "resolution must be 'accept_crm' or 'accept_procore'");
      }

      const result = await db
        .update(procoreSyncState)
        .set({
          syncStatus: "synced",
          conflictData: null,
          errorMessage: null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(procoreSyncState.id, req.params.id as string))
        .returning();

      if (result.length === 0) {
        throw new AppError(404, "Sync conflict record not found");
      }

      await req.commitTransaction!();
      res.json({ success: true, record: result[0] });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/procore/deals/:dealId/sync-state — sync state for a single deal
router.get("/deals/:dealId/sync-state", async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(procoreSyncState)
      .where(
        and(
          eq(procoreSyncState.crmEntityType, "deal"),
          eq(procoreSyncState.crmEntityId, req.params.dealId)
        )
      )
      .limit(1);

    await req.commitTransaction!();
    res.json(rows[0] ?? null);
  } catch (err) {
    next(err);
  }
});

// GET /api/procore/my-projects — rep's deals linked to Procore projects
router.get("/my-projects", async (req, res, next) => {
  try {
    // Raw SQL: join deals to stage config, filter by procore_project_id IS NOT NULL
    // Reps see only their own; directors/admins see all
    const userId = req.user!.id;
    const role = req.user!.role;

    const rows = await req.tenantClient!.query(
      `SELECT d.id, d.deal_number, d.name, d.procore_project_id,
              d.procore_last_synced_at, d.change_order_total,
              psc.name AS stage_name, psc.color AS stage_color
       FROM deals d
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       WHERE d.procore_project_id IS NOT NULL
         AND d.is_active = true
         ${role === "rep" ? "AND d.assigned_rep_id = $1" : ""}
       ORDER BY d.updated_at DESC`,
      role === "rep" ? [userId] : []
    );

    await req.commitTransaction!();
    res.json({ deals: rows.rows });
  } catch (err) {
    next(err);
  }
});

export const procoreRoutes = router;
