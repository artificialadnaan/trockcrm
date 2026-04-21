import { Router, type Request, type Response, type NextFunction } from "express";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { authMiddleware } from "../../middleware/auth.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin, requireDirector } from "../../middleware/rbac.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { pool } from "../../db.js";
import { getAccessibleOffices } from "../auth/service.js";
import {
  listOffices, getOfficeById, createOffice, updateOffice,
} from "./offices-service.js";
import {
  getUsersWithStats, getUserById, getUserLocalAuthEvents, updateUser, grantOfficeAccess, revokeOfficeAccess,
} from "./users-service.js";
import { importExternalUsers } from "./user-import-service.js";
import { previewUserInvite, revokeUserInvite, sendUserInvite } from "../auth/local-auth-service.js";
import { runOwnershipSync } from "./ownership-sync-service.js";
import {
  bulkReassignOwnershipQueueRows,
  getMyCleanupQueue,
  getOfficeOwnershipQueue,
} from "./cleanup-queue-service.js";
import {
  listPipelineStages, updatePipelineStage, reorderPipelineStages,
} from "./pipeline-service.js";
import { getAuditLog, getAuditLogTables } from "./audit-service.js";
import { getAdminDataScrubOverview } from "./admin-reporting-service.js";
import { getDirectorCommissionWorkspace } from "../dashboard/service.js";

const router = Router();
router.use(authMiddleware);

async function withOfficeTenantContext<T>(
  user: NonNullable<Request["user"]>,
  officeId: string,
  handler: (tenantDb: NonNullable<Request["tenantDb"]>) => Promise<T>
): Promise<T> {
  const accessibleOffices = await getAccessibleOffices(user.id, user.role, user.activeOfficeId ?? user.officeId);
  const office = accessibleOffices.find((candidate) => candidate.id === officeId);
  if (!office) {
    throw new AppError(403, "Requested office is not accessible");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('search_path', $1, true)", [`office_${office.slug},public`]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [user.id]);

    const tenantDb = drizzle(client, { schema }) as NonNullable<Request["tenantDb"]>;
    const result = await handler(tenantDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Offices (admin only)
// ---------------------------------------------------------------------------

router.get("/admin/offices", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const officeList = await listOffices();
    return res.json({ offices: officeList });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/offices/:id", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const office = await getOfficeById(req.params.id as string);
    if (!office) return res.status(404).json({ error: "Office not found" });
    return res.json({ office });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/offices", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, slug, address, phone } = req.body as {
      name: string;
      slug: string;
      address?: string;
      phone?: string;
    };
    if (!name || !slug) return res.status(400).json({ error: "name and slug required" });
    const office = await createOffice({ name, slug, address, phone });
    return res.status(201).json({ office });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

router.patch("/admin/offices/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const office = await updateOffice(req.params.id as string, req.body);
    return res.json({ office });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

// ---------------------------------------------------------------------------
// Users (admin only)
// ---------------------------------------------------------------------------

router.get("/admin/users", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userList = await getUsersWithStats();
    return res.json({ users: userList });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/users/import-external", requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await importExternalUsers();
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/users/:id", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUserById(req.params.id as string);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

router.patch("/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = await updateUser(req.params.id as string, req.body);
    return res.json({ user });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

router.post("/admin/users/:id/send-invite", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await sendUserInvite({
      userId: req.params.id as string,
      sentByUserId: req.user!.id,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/users/:id/preview-invite", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const preview = await previewUserInvite({
      userId: req.params.id as string,
      actorUserId: req.user!.id,
    });
    return res.json({ preview });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/users/:id/revoke-invite", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await revokeUserInvite({
      userId: req.params.id as string,
      actorUserId: req.user!.id,
    });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/users/:id/local-auth-events", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const events = await getUserLocalAuthEvents(req.params.id as string);
    return res.json({ events });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/users/:id/office-access", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { officeId, roleOverride } = req.body as {
      officeId: string;
      roleOverride?: "admin" | "director" | "rep";
    };
    if (!officeId) return res.status(400).json({ error: "officeId required" });
    await grantOfficeAccess(req.params.id as string, officeId, roleOverride);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.delete(
  "/admin/users/:id/office-access/:officeId",
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await revokeOfficeAccess(req.params.id as string, req.params.officeId as string);
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  }
);

router.post("/admin/ownership-sync/dry-run", requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runOwnershipSync({ dryRun: true });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/ownership-sync/apply", requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runOwnershipSync({ dryRun: false });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/cleanup/my", tenantMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const result = await getMyCleanupQueue(req.tenantDb!, req.user!.id, officeId);
    await req.commitTransaction!();
    return res.json({ rows: result.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/cleanup/office", requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const officeId = req.query.officeId as string | undefined;
    if (!officeId) {
      return res.status(400).json({ error: "officeId required" });
    }

    const accessibleOffices = await getAccessibleOffices(req.user!.id, req.user!.role, req.user!.activeOfficeId ?? req.user!.officeId);
    const office = accessibleOffices.find((candidate) => candidate.id === officeId);
    if (!office) {
      return res.status(403).json({ error: "Requested office is not accessible" });
    }

    const result = await withOfficeTenantContext(req.user!, officeId, async (tenantDb) => {
      const queue = await getOfficeOwnershipQueue(tenantDb!, officeId, req.user!);
      const assignedIds = Array.from(
        new Set(
          queue.rows
            .map((row) => row.assignedRepId)
            .filter((value): value is string => Boolean(value))
        )
      );

      const assignedNames = assignedIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await tenantDb
                .select({
                  id: schema.users.id,
                  displayName: schema.users.displayName,
                })
                .from(schema.users)
                .where(inArray(schema.users.id, assignedIds))
            ).map((user) => [user.id, user.displayName])
          );

      return {
        rows: queue.rows.map((row) => ({
          ...row,
          officeName: office.name,
          assignedUserName: row.assignedRepId ? assignedNames.get(row.assignedRepId) ?? null : null,
        })),
        byReason: queue.byReason,
      };
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/cleanup/reassign", requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { officeId, rows, assigneeId } = req.body as {
      officeId: string;
      rows: Array<{ recordType: "lead" | "deal"; recordId: string }>;
      assigneeId: string;
    };

    if (!officeId) {
      return res.status(400).json({ error: "officeId required" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows are required" });
    }
    if (!assigneeId) {
      return res.status(400).json({ error: "assigneeId is required" });
    }

    const result = await withOfficeTenantContext(req.user!, officeId, async (tenantDb) =>
      bulkReassignOwnershipQueueRows(tenantDb!, req.user!, {
        officeId,
        rows,
        assigneeId,
      })
    );
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Pipeline config (admin only)
// ---------------------------------------------------------------------------

router.get("/admin/pipeline", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stages = await listPipelineStages();
    return res.json({ stages });
  } catch (err) {
    return next(err);
  }
});

router.patch("/admin/pipeline/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const stage = await updatePipelineStage(req.params.id as string, req.body);
    return res.json({ stage });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message ?? String(err) });
  }
});

router.post("/admin/pipeline/reorder", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderedIds } = req.body as { orderedIds: string[] };
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: "orderedIds required" });
    await reorderPipelineStages(orderedIds);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Audit log (admin + director, requires tenant context)
// ---------------------------------------------------------------------------

router.get(
  "/admin/data-scrub/overview",
  requireDirector,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const overview = await getAdminDataScrubOverview(req.tenantDb!);
      await req.commitTransaction!();
      return res.json(overview);
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/admin/audit",
  requireDirector,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        tableName, recordId, changedBy, action, fromDate, toDate, page, limit,
      } = req.query as Record<string, string>;

      const result = await getAuditLog(req.tenantDb!, {
        tableName: tableName || undefined,
        recordId: recordId || undefined,
        changedBy: changedBy || undefined,
        action: action as any || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 50,
      });

      await req.commitTransaction!();
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/admin/audit/tables",
  requireDirector,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tables = await getAuditLogTables(req.tenantDb!);
      await req.commitTransaction!();
      return res.json({ tables });
    } catch (err) {
      return next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Cross-office reports (director + admin)
// ---------------------------------------------------------------------------

/**
 * Get all office slugs the requesting user has access to.
 * Admins see all active offices. Directors see their primary office
 * plus any offices in user_office_access.
 */
async function getAccessibleOfficeSlugs(userId: string, userRole: string, primaryOfficeId: string): Promise<Array<{ id: string; name: string; slug: string }>> {
  if (userRole === "admin") {
    const result = await pool.query<{ id: string; name: string; slug: string }>(
      "SELECT id, name, slug FROM public.offices WHERE is_active = true ORDER BY name"
    );
    return result.rows;
  }

  // Director: primary office + any extra offices where the user has director/admin role_override.
  // A rep-level cross-office assignment does not grant access to report metrics for that office.
  const result = await pool.query<{ id: string; name: string; slug: string }>(
    `SELECT DISTINCT o.id, o.name, o.slug
     FROM public.offices o
     WHERE o.is_active = true
       AND (
         o.id = $1
         OR o.id IN (
           SELECT office_id FROM public.user_office_access
           WHERE user_id = $2 AND role_override IN ('director', 'admin')
         )
       )
     ORDER BY o.name`,
    [primaryOfficeId, userId]
  );
  return result.rows;
}

async function officeTableExists(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  schemaName: string,
  tableName: string
): Promise<boolean> {
  const result = await client.query(
    "SELECT to_regclass($1) AS relation_name",
    [`${schemaName}.${tableName}`]
  );

  return (result.rows[0]?.relation_name as string | null | undefined) != null;
}

// GET /api/admin/reports/cross-office-pipeline
router.get(
  "/admin/reports/cross-office-pipeline",
  requireDirector,
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await pool.connect();
    try {
      const user = req.user!;
      const offices = await getAccessibleOfficeSlugs(user.id, user.role, user.activeOfficeId ?? user.officeId);

      const results: Array<{
        officeId: string;
        officeName: string;
        officeSlug: string;
        totalDeals: number;
        activeDeals: number;
        totalPipelineValue: number;
        totalAwardedValue: number;
      }> = [];

      for (const office of offices) {
        const schemaName = `office_${office.slug}`;
        try {
          const hasDealsTable = await officeTableExists(client, schemaName, "deals");
          if (!hasDealsTable) {
            results.push({
              officeId: office.id,
              officeName: office.name,
              officeSlug: office.slug,
              totalDeals: 0,
              activeDeals: 0,
              totalPipelineValue: 0,
              totalAwardedValue: 0,
            });
            continue;
          }

          // Use a transaction-local search_path (true = transaction-local, not session-local)
          // so concurrent requests on other connections are not affected.
          await client.query("BEGIN");
          await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
          const row = await client.query<{
            total_deals: string;
            active_deals: string;
            total_pipeline_value: string;
            total_awarded_value: string;
          }>(
            `SELECT
               COUNT(*) AS total_deals,
               COUNT(*) FILTER (WHERE is_active = true) AS active_deals,
               COALESCE(SUM(CASE WHEN is_active = true THEN COALESCE(bid_estimate, dd_estimate, 0) ELSE 0 END), 0) AS total_pipeline_value,
               COALESCE(SUM(COALESCE(awarded_amount, 0)), 0) AS total_awarded_value
             FROM deals`
          );
          await client.query("COMMIT");
          const r = row.rows[0];
          results.push({
            officeId: office.id,
            officeName: office.name,
            officeSlug: office.slug,
            totalDeals: parseInt(r.total_deals, 10),
            activeDeals: parseInt(r.active_deals, 10),
            totalPipelineValue: parseFloat(r.total_pipeline_value),
            totalAwardedValue: parseFloat(r.total_awarded_value),
          });
        } catch (officeErr) {
          await client.query("ROLLBACK").catch(() => {});
          console.error(`[CrossOffice] Pipeline query failed for ${office.slug}:`, officeErr);
          results.push({
            officeId: office.id,
            officeName: office.name,
            officeSlug: office.slug,
            totalDeals: 0,
            activeDeals: 0,
            totalPipelineValue: 0,
            totalAwardedValue: 0,
          });
        }
      }

      return res.json({ offices: results });
    } catch (err) {
      return next(err);
    } finally {
      client.release();
    }
  }
);

// GET /api/admin/reports/cross-office-activity
router.get(
  "/admin/reports/cross-office-activity",
  requireDirector,
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await pool.connect();
    try {
      const user = req.user!;
      const offices = await getAccessibleOfficeSlugs(user.id, user.role, user.activeOfficeId ?? user.officeId);

      const results: Array<{
        officeId: string;
        officeName: string;
        officeSlug: string;
        totalActivities: number;
        activitiesLast30Days: number;
        callCount: number;
        emailCount: number;
        meetingCount: number;
      }> = [];

      for (const office of offices) {
        const schemaName = `office_${office.slug}`;
        try {
          const hasActivitiesTable = await officeTableExists(client, schemaName, "activities");
          if (!hasActivitiesTable) {
            results.push({
              officeId: office.id,
              officeName: office.name,
              officeSlug: office.slug,
              totalActivities: 0,
              activitiesLast30Days: 0,
              callCount: 0,
              emailCount: 0,
              meetingCount: 0,
            });
            continue;
          }

          // Use a transaction-local search_path (true = transaction-local, not session-local)
          // so concurrent requests on other connections are not affected.
          await client.query("BEGIN");
          await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
          const row = await client.query<{
            total_activities: string;
            activities_last_30: string;
            call_count: string;
            email_count: string;
            meeting_count: string;
          }>(
            `SELECT
               COUNT(*) AS total_activities,
               COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '30 days') AS activities_last_30,
               COUNT(*) FILTER (WHERE type = 'call') AS call_count,
               COUNT(*) FILTER (WHERE type = 'email') AS email_count,
               COUNT(*) FILTER (WHERE type = 'meeting') AS meeting_count
             FROM activities`
          );
          await client.query("COMMIT");
          const r = row.rows[0];
          results.push({
            officeId: office.id,
            officeName: office.name,
            officeSlug: office.slug,
            totalActivities: parseInt(r.total_activities, 10),
            activitiesLast30Days: parseInt(r.activities_last_30, 10),
            callCount: parseInt(r.call_count, 10),
            emailCount: parseInt(r.email_count, 10),
            meetingCount: parseInt(r.meeting_count, 10),
          });
        } catch (officeErr) {
          await client.query("ROLLBACK").catch(() => {});
          console.error(`[CrossOffice] Activity query failed for ${office.slug}:`, officeErr);
          results.push({
            officeId: office.id,
            officeName: office.name,
            officeSlug: office.slug,
            totalActivities: 0,
            activitiesLast30Days: 0,
            callCount: 0,
            emailCount: 0,
            meetingCount: 0,
          });
        }
      }

      return res.json({ offices: results });
    } catch (err) {
      return next(err);
    } finally {
      client.release();
    }
  }
);

// GET /api/admin/reports/global-commissions
// Admin-only: rep-level commission + activity + funnel metrics across all offices.
router.get(
  "/admin/reports/global-commissions",
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const offices = await getAccessibleOfficeSlugs(
        user.id,
        user.role,
        user.activeOfficeId ?? user.officeId
      );

      const officeRows = await Promise.all(
        offices.map(async (office) => {
          try {
            const workspace = await withOfficeTenantContext(
              user,
              office.id,
              async (tenantDb) => getDirectorCommissionWorkspace(tenantDb)
            );

            return workspace.rows.map((row) => ({
              officeId: office.id,
              officeName: office.name,
              officeSlug: office.slug,
              repId: row.repId,
              repName: row.repName,
              totalEarnedCommission: row.totalEarnedCommission,
              potentialCommission: row.potentialCommission,
              floorRemaining: row.floorRemaining,
              newCustomerShare: row.newCustomerShare,
              meetsNewCustomerShare: row.meetsNewCustomerShare,
              activeDeals: row.activeDeals,
              pipelineValue: row.pipelineValue,
              leads: row.leads,
              qualifiedLeads: row.qualifiedLeads,
              opportunities: row.opportunities,
              dueDiligence: row.dueDiligence,
              estimating: row.estimating,
              calls: row.calls,
              emails: row.emails,
              meetings: row.meetings,
              notes: row.notes,
              totalActivities: row.totalActivities,
            }));
          } catch (officeErr) {
            console.error(
              `[GlobalCommissions] Failed to aggregate office ${office.slug}:`,
              officeErr
            );
            return [];
          }
        })
      );

      const rows: Array<{
        officeId: string;
        officeName: string;
        officeSlug: string;
        repId: string;
        repName: string;
        totalEarnedCommission: number;
        potentialCommission: number;
        floorRemaining: number;
        newCustomerShare: number;
        meetsNewCustomerShare: boolean;
        activeDeals: number;
        pipelineValue: number;
        leads: number;
        qualifiedLeads: number;
        opportunities: number;
        dueDiligence: number;
        estimating: number;
        calls: number;
        emails: number;
        meetings: number;
        notes: number;
        totalActivities: number;
      }> = officeRows.flat();

      rows.sort((a, b) => {
        if (b.totalEarnedCommission !== a.totalEarnedCommission) {
          return b.totalEarnedCommission - a.totalEarnedCommission;
        }
        if (b.potentialCommission !== a.potentialCommission) {
          return b.potentialCommission - a.potentialCommission;
        }
        if (a.officeName !== b.officeName) {
          return a.officeName.localeCompare(b.officeName);
        }
        return a.repName.localeCompare(b.repName);
      });

      return res.json({ rows });
    } catch (err) {
      return next(err);
    }
  }
);

export { router as adminRoutes };
