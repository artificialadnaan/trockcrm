// server/src/modules/procore/routes.ts
// Procore-specific API routes under /api/procore (tenant-scoped, auth required).

import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { procoreSyncState } from "@trock-crm/shared/schema";
import { TASK_PRIORITIES, TASK_TYPES } from "@trock-crm/shared/types";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { db } from "../../db.js";
import { eventBus } from "../../events/bus.js";
import {
  isProcoreOauthRefreshError,
  isProcoreOauthRequiredError,
  procoreClient,
} from "../../lib/procore-client.js";
import { getUserById } from "../admin/users-service.js";
import { listProjectValidationForOffice } from "./project-validation-service.js";
import {
  createTask,
  getProjectTaskScope,
  getProjectTasks,
  queueTaskCreateSideEffects,
} from "../tasks/service.js";

const router = Router();

async function assertAssignableUserForOffice(assignedTo: string, officeId: string) {
  const user = await getUserById(assignedTo);
  if (!user || !user.isActive) {
    throw new AppError(400, "Assigned user not found or inactive");
  }

  const hasOfficeAccess =
    user.officeId === officeId ||
    user.officeAccess.some((access) => access.officeId === officeId);

  if (!hasOfficeAccess) {
    throw new AppError(400, "Assigned user does not have access to this office");
  }

  return user;
}

// GET /api/procore/sync-status — admin overview
router.get(
  "/sync-status",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const [summary, conflicts, recentActivity] = await Promise.all([
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
        db
          .select()
          .from(procoreSyncState)
          .orderBy(sql`${procoreSyncState.updatedAt} DESC`)
          .limit(20),
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

      // Most recent successful sync timestamp across all records
      const lastSyncedAt =
        recentActivity.find((r) => r.lastSyncedAt != null)?.lastSyncedAt ?? null;

      await req.commitTransaction!();
      res.json({
        summary: summaryMap,
        conflicts,
        recentActivity,
        lastSyncedAt,
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

      // Fetch the conflict record — must belong to the current user's office
      const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
      const [syncRecord] = await db
        .select()
        .from(procoreSyncState)
        .where(
          and(
            eq(procoreSyncState.id, req.params.id as string),
            eq(procoreSyncState.officeId, officeId)
          )
        )
        .limit(1);

      if (!syncRecord) {
        throw new AppError(404, "Sync conflict record not found");
      }

      if (syncRecord.syncStatus !== "conflict") {
        throw new AppError(400, "Record is not in conflict state");
      }

      const officeSlug = req.officeSlug!;
      const schemaName = `office_${officeSlug}`;

      if (resolution === "accept_crm") {
        // Write CRM value to Procore via API
        const companyId = process.env.PROCORE_COMPANY_ID;
        if (!companyId) throw new AppError(500, "PROCORE_COMPANY_ID not configured");

        // Get the CRM deal's current stage to push to Procore
        const dealResult = await req.tenantClient!.query(
          `SELECT d.id, d.name, psc.procore_stage_mapping
           FROM deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
           WHERE d.id = $1 LIMIT 1`,
          [syncRecord.crmEntityId]
        );

        if (dealResult.rows[0]?.procore_stage_mapping) {
          await procoreClient.patch(
            `/rest/v1.0/companies/${companyId}/projects/${syncRecord.procoreId}`,
            { project: { stage: dealResult.rows[0].procore_stage_mapping } }
          );
        }
      } else {
        // accept_procore: update CRM record from Procore data stored in conflict_data
        const conflictData = syncRecord.conflictData as any;
        if (conflictData?.procore_status) {
          // Look up stage config that maps to this Procore status
          const stageResult = await req.tenantClient!.query(
            `SELECT id FROM public.pipeline_stage_config
             WHERE procore_stage_mapping = $1 LIMIT 1`,
            [conflictData.procore_status]
          );
          if (stageResult.rows[0]) {
            await req.tenantClient!.query(
              `UPDATE deals SET stage_id = $1, updated_at = NOW() WHERE id = $2`,
              [stageResult.rows[0].id, syncRecord.crmEntityId]
            );
          }
        }
      }

      // Only clear conflict after the authoritative update succeeds
      const result = await db
        .update(procoreSyncState)
        .set({
          syncStatus: "synced",
          conflictData: null,
          errorMessage: null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(procoreSyncState.id, req.params.id as string),
            eq(procoreSyncState.officeId, officeId)
          )
        )
        .returning();

      await req.commitTransaction!();
      res.json({ success: true, record: result[0] });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/procore/project-validation — admin read-only project validation
router.get(
  "/project-validation",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const companyId = process.env.PROCORE_COMPANY_ID;
      if (!companyId) throw new AppError(500, "PROCORE_COMPANY_ID not configured");

      const result = await listProjectValidationForOffice(req.tenantDb!, {
        companyId,
        pageSize: 100,
        maxProjects: 500,
      });

      await req.commitTransaction!();
      res.json(result);
    } catch (err) {
      if (isProcoreOauthRequiredError(err) || isProcoreOauthRefreshError(err)) {
        return next(new AppError(503, "Procore authentication required"));
      }

      return next(err);
    }
  }
);

// GET /api/procore/deals/:dealId/sync-state — sync state for a single deal
router.get("/deals/:dealId/sync-state", async (req, res, next) => {
  try {
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const rows = await db
      .select()
      .from(procoreSyncState)
      .where(
        and(
          eq(procoreSyncState.crmEntityType, "deal"),
          eq(procoreSyncState.crmEntityId, req.params.dealId),
          eq(procoreSyncState.officeId, officeId)
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

// GET /api/procore/my-projects/:id — single deal-backed project for the project detail shell
router.get("/my-projects/:id", async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const params = role === "rep" ? [req.params.id, userId] : [req.params.id];

    const rows = await req.tenantClient!.query(
      `SELECT d.id, d.deal_number, d.name, d.procore_project_id,
              d.procore_last_synced_at, d.change_order_total,
              psc.name AS stage_name, psc.color AS stage_color
       FROM deals d
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       WHERE d.procore_project_id IS NOT NULL
         AND d.is_active = true
         AND d.id = $1
         ${role === "rep" ? "AND d.assigned_rep_id = $2" : ""}
       LIMIT 1`,
      params
    );

    const project = rows.rows[0] ?? null;
    if (!project) {
      throw new AppError(404, "Project not found");
    }

    await req.commitTransaction!();
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

// GET /api/procore/my-projects/:id/tasks — project-scoped task list
router.get("/my-projects/:id/tasks", async (req, res, next) => {
  try {
    const project = await getProjectTaskScope(
      req.tenantDb!,
      req.params.id,
      req.user!.role,
      req.user!.id
    );
    if (!project) {
      throw new AppError(404, "Project not found");
    }

    const tasks = await getProjectTasks(
      req.tenantDb!,
      req.params.id,
      req.user!.role,
      req.user!.id
    );

    await req.commitTransaction!();
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

// POST /api/procore/my-projects/:id/tasks — create project-scoped task
router.post(
  "/my-projects/:id/tasks",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const projectId = req.params.id as string;
      const { title, description, type, priority, assignedTo, dueDate, dueTime, remindAt } = req.body;
      const officeId = req.user!.activeOfficeId ?? req.user!.officeId;

      if (!title) throw new AppError(400, "Title is required");
      if (typeof assignedTo !== "string" || assignedTo.length === 0) {
        throw new AppError(400, "assignedTo is required");
      }
      if (priority && !TASK_PRIORITIES.includes(priority)) {
        throw new AppError(400, `Invalid priority. Must be one of: ${TASK_PRIORITIES.join(", ")}`);
      }
      if (type && !TASK_TYPES.includes(type)) {
        throw new AppError(400, `Invalid task type. Must be one of: ${TASK_TYPES.join(", ")}`);
      }

      const project = await getProjectTaskScope(
        req.tenantDb!,
        projectId,
        req.user!.role,
        req.user!.id
      );
      if (!project) {
        throw new AppError(404, "Project not found");
      }

      await assertAssignableUserForOffice(assignedTo, officeId);
      const task = await createTask(req.tenantDb!, {
        title,
        description,
        type: type ?? "manual",
        priority,
        assignedTo,
        createdBy: req.user!.id,
        dealId: projectId,
        dueDate,
        dueTime,
        remindAt,
      });

      const sideEffects = await queueTaskCreateSideEffects(req.tenantDb!, task, {
        actorUserId: req.user!.id,
        officeId,
      });

      await req.commitTransaction!();

      if (sideEffects.shouldEmitAssignmentEvent) {
        try {
          eventBus.emitLocal({
            name: "task.assigned",
            payload: {
              taskId: task.id,
              assignedTo: task.assignedTo,
              title: task.title,
            },
            officeId,
            userId: req.user!.id,
            timestamp: new Date(),
          });
        } catch (eventErr) {
          console.error("[Tasks] Failed to emit task.assigned event:", eventErr);
        }
      }

      res.status(201).json({ task });
    } catch (err) {
      next(err);
    }
  }
);

export const procoreRoutes = router;
