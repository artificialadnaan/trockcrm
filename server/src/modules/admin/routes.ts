import { Router, type Request, type Response, type NextFunction } from "express";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { authMiddleware } from "../../middleware/auth.js";
import { requireCrmUser } from "../../middleware/field-auth.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin, requireDirector, requireGlobalAdmin } from "../../middleware/rbac.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { pool } from "../../db.js";
import { getAccessibleOffices } from "../auth/service.js";
import {
  listOffices, getOfficeById, createOffice, updateOffice,
} from "./offices-service.js";
import {
  getUsersWithStats, getUserById, getUserLocalAuthEvents, updateUser, grantOfficeAccess, revokeOfficeAccess, createCrmUser,
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
import { getAuditLog, getAuditLogCount, getAuditLogEntityTypes } from "./audit-service.js";
import {
  getAdminPhotoAuditEvents,
  parseCsvQueryParam,
  parsePhotoAuditEventTypes,
  logPhotoEvent,
} from "../files/audit-log-service.js";
import { fieldUserAdminRouter } from "../field-users/routes.js";
import { getAdminDataScrubOverview } from "./admin-reporting-service.js";
import { getDirectorCommissionWorkspace } from "../dashboard/service.js";
import { startCatalogSync } from "../procore/sync-service.js";
import {
  listDirectoryMergeQueue,
  resolveDirectoryMergeQueueEntry,
} from "../../services/directoryDedup.js";
import {
  decideLeadDueDiligenceApproval,
  getNotificationRecipientGroup,
  listLeadDueDiligenceApprovals,
  updateNotificationRecipientAssignments,
} from "../leads/due-diligence-service.js";

const router = Router();
router.use(authMiddleware);
router.use(requireCrmUser);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

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

router.get("/admin/users", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userList = await getUsersWithStats();
    return res.json({ users: userList });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/users/import-external", requireGlobalAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await importExternalUsers();
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/users", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await createCrmUser(req.body, req.user!.id);
    let invite: { sent: boolean; error?: string } = { sent: false };
    if (req.body?.sendInvite !== false) {
      try {
        await sendUserInvite({ userId: user.id, sentByUserId: req.user!.id });
        invite = { sent: true };
      } catch (e: any) {
        invite = { sent: false, error: e?.message ?? "Invite failed" };
      }
    }
    return res.status(201).json({ user, invite });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/users/:id", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUserById(req.params.id as string);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

router.patch("/admin/users/:id", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await updateUser(req.params.id as string, req.body, req.user!.id);
    return res.json({ user });
  } catch (err) {
    // Route through the global error handler so guard rejections return the canonical
    // { error: { message, code } } shape the client parses (not { error: string }).
    return next(err);
  }
});

router.post("/admin/users/:id/send-invite", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
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

router.post("/admin/users/:id/preview-invite", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
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

router.post("/admin/users/:id/revoke-invite", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
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

router.get("/admin/users/:id/local-auth-events", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const events = await getUserLocalAuthEvents(req.params.id as string);
    return res.json({ events });
  } catch (err) {
    return next(err);
  }
});

router.use("/admin/field-users", fieldUserAdminRouter);

router.post("/admin/users/:id/office-access", requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
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
  requireGlobalAdmin,
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

router.get("/admin/directory-merge-queue", tenantMiddleware, requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entries = await listDirectoryMergeQueue(req.tenantDb!, req.query.status as string | undefined);
    await req.commitTransaction!();
    return res.json({ entries });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/directory-merge-queue/:id/merge", tenantMiddleware, requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await resolveDirectoryMergeQueueEntry(
      req.tenantDb!,
      req.params.id as string,
      "merge",
      req.user!.id,
      req.body?.winnerId
    );
    await req.commitTransaction!();
    return res.json({ result });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/directory-merge-queue/:id/dismiss", tenantMiddleware, requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await resolveDirectoryMergeQueueEntry(
      req.tenantDb!,
      req.params.id as string,
      "dismiss",
      req.user!.id
    );
    await req.commitTransaction!();
    return res.json({ result });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/lead-due-diligence-approvals", tenantMiddleware, requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status === "approved" || req.query.status === "rejected"
      ? req.query.status
      : "pending";
    const approvals = await listLeadDueDiligenceApprovals(req.tenantDb!, status);
    await req.commitTransaction!();
    return res.json({ approvals });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/lead-due-diligence-approvals/:id/approve", tenantMiddleware, requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approval = await decideLeadDueDiligenceApproval(req.tenantDb!, {
      approvalId: req.params.id as string,
      decision: "approve",
      userId: req.user!.id,
    });
    await req.commitTransaction!();
    return res.json({ approval });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/lead-due-diligence-approvals/:id/reject", tenantMiddleware, requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approval = await decideLeadDueDiligenceApproval(req.tenantDb!, {
      approvalId: req.params.id as string,
      decision: "reject",
      reason: typeof req.body?.reason === "string" ? req.body.reason : null,
      userId: req.user!.id,
    });
    await req.commitTransaction!();
    return res.json({ approval });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/lead-dd-debug", requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  const leadId = req.query.leadId;

  if (!leadId || typeof leadId !== "string") {
    return res.status(400).json({ error: "leadId required" });
  }

  if (!UUID_PATTERN.test(leadId)) {
    return res.status(400).json({ error: "invalid leadId format" });
  }

  return next();
}, tenantMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leadId = req.query.leadId as string;

    const leadRows = rowsFrom<{
      id: string;
      name: string;
      stage_slug: string;
      company_id: string;
      primary_contact_id: string | null;
      property_id: string | null;
      verification_status: string | null;
      verification_required_reason: string | null;
      created_at: string | Date;
      last_activity_at: string | Date | null;
    }>(await req.tenantDb!.execute(sql`
      SELECT l.id,
             l.name,
             psc.slug AS stage_slug,
             l.company_id,
             l.primary_contact_id,
             l.property_id,
             l.verification_status,
             l.verification_required_reason,
             l.created_at,
             l.last_activity_at
        FROM leads l
        LEFT JOIN public.pipeline_stage_config psc ON psc.id = l.stage_id
       WHERE l.id = ${leadId}::uuid
       LIMIT 1
    `));
    const lead = leadRows[0];

    if (!lead) {
      await req.commitTransaction!();
      return res.status(404).json({ error: "Lead not found" });
    }

    const approvalRows = rowsFrom<{
      id: string;
      status: string;
      requested_at: string | Date;
      email_sent_at: string | Date | null;
      email_message_id: string | null;
      detection_signal: Record<string, unknown> | null;
      decided_at: string | Date | null;
      decided_by: string | null;
    }>(await req.tenantDb!.execute(sql`
      SELECT id,
             status,
             requested_at,
             email_sent_at,
             email_message_id,
             detection_signal,
             decided_at,
             decided_by
        FROM lead_due_diligence_approvals
       WHERE lead_id = ${leadId}::uuid
       ORDER BY requested_at DESC
       LIMIT 1
    `));

    const recipientRows = rowsFrom<{ email: string; is_active: boolean }>(await req.tenantDb!.execute(sql`
      SELECT u.email,
             u.is_active
        FROM public.notification_recipient_groups g
        JOIN public.notification_recipient_assignments a ON a.group_id = g.id
        JOIN public.users u ON u.id = a.user_id
       WHERE g.key = 'lead_due_diligence'
       ORDER BY u.email ASC
    `));

    const detectionRows = rowsFrom<{
      source: string;
      type: string;
      occurred_at: string | Date;
      detail: string;
      record_id: string;
    }>(await req.tenantDb!.execute(sql`
      WITH cutoff AS (
        SELECT (${lead.created_at}::timestamptz - INTERVAL '12 months') AS cutoff_at
      ),
      signal_candidates AS (
        SELECT 'company-lead'::text AS source,
               'lead'::text AS type,
               GREATEST(l.created_at, COALESCE(l.last_activity_at, l.created_at)) AS occurred_at,
               'Recent lead activity on company'::text AS detail,
               l.id AS record_id
          FROM leads l
         WHERE l.company_id = ${lead.company_id}::uuid
           AND l.id <> ${leadId}::uuid
        UNION ALL
        SELECT 'company-deal', 'deal',
               GREATEST(d.created_at, COALESCE(d.last_activity_at, d.created_at)),
               'Recent deal activity on company',
               d.id
          FROM deals d
         WHERE d.company_id = ${lead.company_id}::uuid
        UNION ALL
        SELECT 'company-activity', 'activity', a.occurred_at, COALESCE(a.subject, 'Recent activity on company'), a.id
          FROM activities a
         WHERE a.company_id = ${lead.company_id}::uuid
        UNION ALL
        SELECT 'company-email', 'email', e.sent_at, COALESCE(e.subject, 'Recent email on company'), e.id
          FROM emails e
          LEFT JOIN contacts c ON c.id = e.contact_id
          LEFT JOIN deals d ON d.id = e.deal_id
         WHERE e.direction IN ('inbound','outbound')
           AND (
             c.company_id = ${lead.company_id}::uuid
             OR d.company_id = ${lead.company_id}::uuid
             OR (e.assigned_entity_type = 'company' AND e.assigned_entity_id = ${lead.company_id}::uuid)
           )
        UNION ALL
        SELECT 'contact-lead', 'lead',
               GREATEST(l.created_at, COALESCE(l.last_activity_at, l.created_at)),
               'Recent lead activity on primary contact',
               l.id
          FROM leads l
         WHERE ${lead.primary_contact_id}::uuid IS NOT NULL
           AND l.primary_contact_id = ${lead.primary_contact_id}::uuid
           AND l.id <> ${leadId}::uuid
        UNION ALL
        SELECT 'contact-deal', 'deal',
               GREATEST(d.created_at, COALESCE(d.last_activity_at, d.created_at)),
               'Recent deal activity on primary contact',
               d.id
          FROM deals d
         WHERE ${lead.primary_contact_id}::uuid IS NOT NULL
           AND d.primary_contact_id = ${lead.primary_contact_id}::uuid
        UNION ALL
        SELECT 'contact-activity', 'activity', a.occurred_at, COALESCE(a.subject, 'Recent activity on primary contact'), a.id
          FROM activities a
         WHERE ${lead.primary_contact_id}::uuid IS NOT NULL
           AND a.contact_id = ${lead.primary_contact_id}::uuid
        UNION ALL
        SELECT 'contact-email', 'email', e.sent_at, COALESCE(e.subject, 'Recent email on primary contact'), e.id
          FROM emails e
         WHERE ${lead.primary_contact_id}::uuid IS NOT NULL
           AND e.direction IN ('inbound','outbound')
           AND (e.contact_id = ${lead.primary_contact_id}::uuid OR (e.assigned_entity_type = 'contact' AND e.assigned_entity_id = ${lead.primary_contact_id}::uuid))
        UNION ALL
        SELECT 'property-lead', 'lead',
               GREATEST(l.created_at, COALESCE(l.last_activity_at, l.created_at)),
               'Recent lead activity on property',
               l.id
          FROM leads l
         WHERE ${lead.property_id}::uuid IS NOT NULL
           AND l.property_id = ${lead.property_id}::uuid
           AND l.id <> ${leadId}::uuid
        UNION ALL
        SELECT 'property-deal', 'deal',
               GREATEST(d.created_at, COALESCE(d.last_activity_at, d.created_at)),
               'Recent deal activity on property',
               d.id
          FROM deals d
         WHERE ${lead.property_id}::uuid IS NOT NULL
           AND d.property_id = ${lead.property_id}::uuid
        UNION ALL
        SELECT 'property-activity', 'activity', a.occurred_at, COALESCE(a.subject, 'Recent activity on property'), a.id
          FROM activities a
         WHERE ${lead.property_id}::uuid IS NOT NULL
           AND a.property_id = ${lead.property_id}::uuid
      )
      SELECT source, type, occurred_at, detail, record_id
        FROM signal_candidates, cutoff
       WHERE occurred_at >= cutoff.cutoff_at
       ORDER BY occurred_at DESC, source ASC, type ASC
    `));

    const leadsOnCompany = await req.tenantDb!.execute(sql`
        SELECT l.id, l.name, l.created_at, psc.slug AS stage_slug
          FROM leads l
          LEFT JOIN public.pipeline_stage_config psc ON psc.id = l.stage_id
         WHERE l.company_id = ${lead.company_id}::uuid
           AND l.id <> ${leadId}::uuid
         ORDER BY l.created_at DESC
         LIMIT 5
      `);
    const dealsOnCompany = await req.tenantDb!.execute(sql`
        SELECT id, name, created_at
          FROM deals
         WHERE company_id = ${lead.company_id}::uuid
         ORDER BY created_at DESC
         LIMIT 5
      `);
    const leadsOnContact = await req.tenantDb!.execute(sql`
        SELECT l.id, l.name, l.created_at, psc.slug AS stage_slug
          FROM leads l
          LEFT JOIN public.pipeline_stage_config psc ON psc.id = l.stage_id
         WHERE ${lead.primary_contact_id}::uuid IS NOT NULL
           AND l.primary_contact_id = ${lead.primary_contact_id}::uuid
           AND l.id <> ${leadId}::uuid
         ORDER BY l.created_at DESC
         LIMIT 5
      `);
    const activitiesOnCompany = await req.tenantDb!.execute(sql`
        SELECT id, occurred_at, subject
          FROM activities
         WHERE company_id = ${lead.company_id}::uuid
         ORDER BY occurred_at DESC
         LIMIT 5
      `);
    const emailsOnContact = await req.tenantDb!.execute(sql`
        SELECT id, sent_at, subject, direction
          FROM emails
         WHERE ${lead.primary_contact_id}::uuid IS NOT NULL
           AND (contact_id = ${lead.primary_contact_id}::uuid OR (assigned_entity_type = 'contact' AND assigned_entity_id = ${lead.primary_contact_id}::uuid))
         ORDER BY sent_at DESC
         LIMIT 5
      `);

    await req.commitTransaction!();

    return res.json({
      lead,
      duediligence: {
        approval_row: approvalRows[0] ?? null,
        recipients: recipientRows,
      },
      detection_signals_found: detectionRows,
      detection_signals_within_12mo: detectionRows.length,
      recent_activity: {
        leads_on_company: rowsFrom(leadsOnCompany),
        deals_on_company: rowsFrom(dealsOnCompany),
        leads_on_contact: rowsFrom(leadsOnContact),
        activities_on_company: rowsFrom(activitiesOnCompany),
        emails_on_contact: rowsFrom(emailsOnContact),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/notification-recipient-groups/:key", requireDirector, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await getNotificationRecipientGroup(req.tenantDb ?? (drizzle(pool) as any), req.params.key as string);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.put("/admin/notification-recipient-groups/:key/assignments", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userIds = Array.isArray(req.body?.userIds)
      ? req.body.userIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const result = await updateNotificationRecipientAssignments(
      req.tenantDb ?? (drizzle(pool) as any),
      req.params.key as string,
      userIds
    );
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

router.post("/admin/procore/catalog-sync", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const syncRun = await startCatalogSync({
      triggeredByUserId: req.user?.id ?? null,
    });
    return res.status(202).json({ syncRun });
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
        entityType, actorQuery, action, fromDate, toDate, expand, cursor, page, limit,
      } = req.query as Record<string, string>;

      const result = await getAuditLog(req.tenantDb!, req.user!.role, {
        entityType: entityType || undefined,
        actorQuery: actorQuery || undefined,
        action: action as any || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        expand: expand || undefined,
        cursor: cursor || undefined,
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
  "/admin/audit/entity-types",
  requireDirector,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entityTypes = await getAuditLogEntityTypes(req.tenantDb!);
      await req.commitTransaction!();
      return res.json({ entityTypes });
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/admin/audit/count",
  requireDirector,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        entityType, actorQuery, action, fromDate, toDate,
      } = req.query as Record<string, string>;

      const result = await getAuditLogCount(req.tenantDb!, {
        entityType: entityType || undefined,
        actorQuery: actorQuery || undefined,
        action: action as any || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });

      await req.commitTransaction!();
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/admin/photo-audit",
  requireAdmin,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getAdminPhotoAuditEvents(req.tenantDb!, {
        userIds: parseCsvQueryParam(req.query.userId),
        eventTypes: parsePhotoAuditEventTypes(req.query.eventType),
        from: typeof req.query.from === "string" ? req.query.from : undefined,
        to: typeof req.query.to === "string" ? req.query.to : undefined,
        dealId: typeof req.query.dealId === "string" && req.query.dealId ? req.query.dealId : undefined,
        photoId: typeof req.query.photoId === "string" && req.query.photoId ? req.query.photoId : undefined,
        procoreSyncStatuses: parseCsvQueryParam(req.query.procoreSyncStatus),
        page: typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1,
        perPage: typeof req.query.perPage === "string" ? parseInt(req.query.perPage, 10) : 50,
      });

      await req.commitTransaction!();
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/admin/photos/:photoId/procore-retry",
  requireAdmin,
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const photoId = req.params.photoId as string;
      if (!UUID_PATTERN.test(photoId)) {
        throw new AppError(400, "Invalid photo id");
      }

      const photoResult = await req.tenantClient!.query(
        `SELECT f.id, f.deal_id, f.procore_sync_status, d.procore_project_id, d.procore_photo_link_id, d.procore_photo_link_status
         FROM files f
         JOIN deals d ON d.id = f.deal_id
         WHERE f.id = $1
           AND f.category = 'photo'
           AND f.deleted_at IS NULL
           AND f.is_active = true
         LIMIT 1`,
        [photoId]
      );
      const photo = photoResult.rows[0];
      if (!photo) throw new AppError(404, "Photo not found");
      if (!photo.procore_project_id) throw new AppError(400, "Deal is not linked to a Procore project");

      await req.tenantClient!.query(
        `UPDATE files
         SET procore_sync_status = 'pending',
             updated_at = NOW()
         WHERE id = $1`,
        [photoId]
      );
      const jobResult = await req.tenantClient!.query(
        `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after, max_attempts)
         VALUES ('procore_photo_sync', $1::jsonb, $2::uuid, 'pending', NOW(), 3)
         RETURNING id`,
        [
          JSON.stringify({
            action: "single",
            dealId: photo.deal_id,
            photoId,
            officeId: req.user!.activeOfficeId,
            requestedByUserId: req.user!.id,
          }),
          req.user!.activeOfficeId,
        ]
      );
      const jobId = rowsFrom<{ id: number | string }>(jobResult)[0]?.id ?? null;

      try {
        await logPhotoEvent(req.tenantDb!, {
          photoId,
          eventType: "procore_sync_retry_requested",
          userId: req.user!.id,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? null,
          metadata: {
            previousStatus: photo.procore_sync_status ?? null,
            jobId,
          },
        });
      } catch (auditError) {
        console.error("[admin] Failed to write Procore retry audit event", auditError);
      }

      await req.commitTransaction!();
      return res.json({ queued: true, photoId, status: "pending" });
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
               COALESCE(SUM(CASE WHEN is_active = true AND COALESCE(on_hold, false) = false AND COALESCE(psc.is_terminal, false) = false THEN COALESCE(
                 CASE WHEN bid_board_total_sales > 0 THEN bid_board_total_sales END,
                 CASE WHEN bid_estimate > 0 THEN bid_estimate END,
                 CASE WHEN dd_estimate > 0 THEN dd_estimate END,
                 CASE WHEN awarded_amount > 0 THEN awarded_amount END,
                 0
               ) ELSE 0 END), 0) AS total_pipeline_value,
               COALESCE(SUM(CASE WHEN is_active = true AND COALESCE(on_hold, false) = false AND awarded_amount > 0 THEN awarded_amount ELSE 0 END), 0) AS total_awarded_value
             FROM deals
             LEFT JOIN public.pipeline_stage_config psc ON psc.id = deals.stage_id`
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
