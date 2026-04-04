import { and, desc, eq, inArray } from "drizzle-orm";
import { taskResolutionState, tasks } from "@trock-crm/shared/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type {
  TaskBusinessKey,
  TaskRecord,
  TaskResolutionStateRecord,
  TaskRulePersistence,
  SystemTaskDraft,
} from "./types.js";

type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type TenantDb = NodePgDatabase<typeof schema>;

const ACTIVE_TASK_STATUSES = ["pending", "scheduled", "in_progress", "waiting_on", "blocked"] as const;

function mapTaskRow(row: Record<string, any>): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    assignedTo: row.assigned_to,
    officeId: row.office_id ?? null,
    originRule: row.origin_rule ?? "",
    sourceRule: row.source_rule ?? undefined,
    sourceEvent: row.source_event ?? "",
    dedupeKey: row.dedupe_key ?? "",
    reasonCode: row.reason_code ?? "",
    priority: row.priority,
    priorityScore: row.priority_score ?? 0,
    status: row.status,
    dueAt: row.due_at ?? null,
    entitySnapshot: row.entity_snapshot ?? null,
    metadata: row.metadata ?? null,
    createdBy: row.created_by ?? null,
    scheduledFor: row.scheduled_for ?? null,
    waitingOn: row.waiting_on ?? null,
    blockedBy: row.blocked_by ?? null,
    startedAt: row.started_at ?? null,
    dealId: row.deal_id ?? null,
    contactId: row.contact_id ?? null,
    emailId: row.email_id ?? null,
    dueDate: row.due_date ?? null,
    dueTime: row.due_time ?? null,
    remindAt: row.remind_at ?? null,
    completedAt: row.completed_at ?? null,
    isOverdue: row.is_overdue ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as TaskRecord;
}

function mapResolutionRow(row: Record<string, any>): TaskResolutionStateRecord {
  return {
    originRule: row.origin_rule,
    dedupeKey: row.dedupe_key,
    resolutionStatus: row.resolution_status,
    resolvedAt: row.resolved_at ?? null,
    suppressedUntil: row.suppressed_until ?? null,
  };
}

function toNullableDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function taskDraftColumns(draft: SystemTaskDraft) {
  return {
    title: draft.title,
    description: draft.description ?? null,
    type: draft.type,
    priority: draft.priority,
    status: draft.status ?? "pending",
    assignedTo: draft.assignedTo,
    officeId: draft.officeId,
    originRule: draft.originRule,
    sourceRule: draft.sourceRule ?? null,
    sourceEvent: draft.sourceEvent,
    dedupeKey: draft.dedupeKey,
    reasonCode: draft.reasonCode,
    entitySnapshot: draft.entitySnapshot ?? null,
    dealId: draft.dealId ?? null,
    contactId: draft.contactId ?? null,
    emailId: draft.emailId ?? null,
    dueDate: toNullableDate(draft.dueAt),
    dueTime: null,
    remindAt: null,
  };
}

function mapDrizzleTaskRow(row: typeof tasks.$inferSelect): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    assignedTo: row.assignedTo,
    officeId: row.officeId ?? "",
    originRule: row.originRule ?? "",
    sourceRule: row.sourceRule ?? undefined,
    sourceEvent: row.sourceEvent ?? "",
    dedupeKey: row.dedupeKey ?? "",
    reasonCode: row.reasonCode ?? "",
    priority: row.priority,
    priorityScore: 0,
    status: row.status as TaskRecord["status"],
    dueAt: row.dueDate ?? null,
    entitySnapshot: (row.entitySnapshot as Record<string, unknown> | null) ?? null,
    metadata: null,
    dealId: row.dealId ?? null,
    contactId: row.contactId ?? null,
    emailId: row.emailId ?? null,
  };
}

function taskDraftValues(draft: SystemTaskDraft) {
  return {
    title: draft.title,
    description: draft.description ?? null,
    type: draft.type as (typeof tasks.$inferInsert)["type"],
    priority: draft.priority,
    priorityScore: draft.priorityScore,
    status: draft.status ?? "pending",
    assignedTo: draft.assignedTo,
    officeId: draft.officeId,
    originRule: draft.originRule,
    sourceRule: draft.sourceRule ?? null,
    sourceEvent: draft.sourceEvent,
    dedupeKey: draft.dedupeKey,
    reasonCode: draft.reasonCode,
    entitySnapshot: draft.entitySnapshot ?? null,
    metadata: draft.metadata ?? {},
    dealId: draft.dealId ?? null,
    contactId: draft.contactId ?? null,
    emailId: draft.emailId ?? null,
    dueDate: toNullableDate(draft.dueAt),
    dueTime: null,
    remindAt: null,
  };
}


export function createTenantTaskRulePersistence(
  client: Queryable,
  schemaName: string
): TaskRulePersistence {
  const activeStatusesSql = ACTIVE_TASK_STATUSES.map((status) => `'${status}'`).join(", ");

  return {
    async findOpenTaskByBusinessKey({ originRule, dedupeKey }: TaskBusinessKey) {
      const result = await client.query(
        `SELECT
           id,
           title,
           description,
           type,
           priority,
           status,
           assigned_to,
           created_by,
           office_id,
           origin_rule,
           source_rule,
           source_event,
           dedupe_key,
           reason_code,
           entity_snapshot,
           scheduled_for,
           waiting_on,
           blocked_by,
           started_at,
           deal_id,
           contact_id,
           email_id,
           due_date,
           due_time,
           remind_at,
           completed_at,
           is_overdue,
           created_at,
           updated_at
         FROM ${schemaName}.tasks
         WHERE origin_rule = $1
           AND dedupe_key = $2
           AND status IN (${activeStatusesSql})
         ORDER BY updated_at DESC
         LIMIT 1`,
        [originRule, dedupeKey]
      );

      return result.rows[0] ? mapTaskRow(result.rows[0]) : null;
    },

    async findResolutionStateByBusinessKey({ originRule, dedupeKey }: TaskBusinessKey) {
      const result = await client.query(
        `SELECT
           origin_rule,
           dedupe_key,
           resolution_status,
           resolved_at,
           suppressed_until
         FROM ${schemaName}.task_resolution_state
         WHERE origin_rule = $1
           AND dedupe_key = $2
         LIMIT 1`,
        [originRule, dedupeKey]
      );

      return result.rows[0] ? mapResolutionRow(result.rows[0]) : null;
    },

    async insertTask(draft: SystemTaskDraft) {
      const columns = taskDraftColumns(draft);
      const result = await client.query(
        `INSERT INTO ${schemaName}.tasks
           (title, description, type, priority, status, assigned_to, office_id, origin_rule,
            source_rule, source_event, dedupe_key, reason_code, entity_snapshot, deal_id, contact_id,
            email_id, due_date, due_time, remind_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING
           id,
           title,
           description,
           type,
           priority,
           status,
           assigned_to,
           created_by,
           office_id,
           origin_rule,
           source_rule,
           source_event,
           dedupe_key,
           reason_code,
           entity_snapshot,
           scheduled_for,
           waiting_on,
           blocked_by,
           started_at,
           deal_id,
           contact_id,
           email_id,
           due_date,
           due_time,
           remind_at,
           completed_at,
           is_overdue,
           created_at,
           updated_at`,
        [
          columns.title,
          columns.description,
          columns.type,
          columns.priority,
          columns.status,
          columns.assignedTo,
          columns.officeId,
          columns.originRule,
          columns.sourceRule,
          columns.sourceEvent,
          columns.dedupeKey,
          columns.reasonCode,
          columns.entitySnapshot,
          columns.dealId,
          columns.contactId,
          columns.emailId,
          columns.dueDate,
          columns.dueTime,
          columns.remindAt,
        ]
      );

      return mapTaskRow(result.rows[0]);
    },

    async updateTask(taskId: string, draft: SystemTaskDraft) {
      const columns = taskDraftColumns(draft);
      const result = await client.query(
        `UPDATE ${schemaName}.tasks
         SET title = $2,
             description = $3,
             type = $4,
             priority = $5,
             status = $6,
             assigned_to = $7,
             office_id = $8,
             origin_rule = $9,
             source_rule = $10,
             source_event = $11,
             dedupe_key = $12,
             reason_code = $13,
             entity_snapshot = $14,
             deal_id = $15,
             contact_id = $16,
             email_id = $17,
             due_date = $18,
             due_time = $19,
             remind_at = $20,
             updated_at = NOW()
         WHERE id = $1
         RETURNING
           id,
           title,
           description,
           type,
           priority,
           status,
           assigned_to,
           created_by,
           office_id,
           origin_rule,
           source_rule,
           source_event,
           dedupe_key,
           reason_code,
           entity_snapshot,
           scheduled_for,
           waiting_on,
           blocked_by,
           started_at,
           deal_id,
           contact_id,
           email_id,
           due_date,
           due_time,
           remind_at,
           completed_at,
           is_overdue,
           created_at,
           updated_at`,
        [
          taskId,
          columns.title,
          columns.description,
          columns.type,
          columns.priority,
          columns.status,
          columns.assignedTo,
          columns.officeId,
          columns.originRule,
          columns.sourceRule,
          columns.sourceEvent,
          columns.dedupeKey,
          columns.reasonCode,
          columns.entitySnapshot,
          columns.dealId,
          columns.contactId,
          columns.emailId,
          columns.dueDate,
          columns.dueTime,
          columns.remindAt,
        ]
      );

      return mapTaskRow(result.rows[0]);
    },
  };
}

export function createDrizzleTaskRulePersistence(tenantDb: TenantDb): TaskRulePersistence {
  return {
    async findOpenTaskByBusinessKey({ originRule, dedupeKey }: TaskBusinessKey) {
      const result = await tenantDb
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.originRule, originRule),
            eq(tasks.dedupeKey, dedupeKey),
            inArray(tasks.status, [...ACTIVE_TASK_STATUSES])
          )
        )
        .orderBy(desc(tasks.updatedAt))
        .limit(1);

      return result[0] ? mapDrizzleTaskRow(result[0]) : null;
    },

    async findResolutionStateByBusinessKey({ originRule, dedupeKey }: TaskBusinessKey) {
      const result = await tenantDb
        .select({
          originRule: taskResolutionState.originRule,
          dedupeKey: taskResolutionState.dedupeKey,
          resolutionStatus: taskResolutionState.resolutionStatus,
          resolvedAt: taskResolutionState.resolvedAt,
          suppressedUntil: taskResolutionState.suppressedUntil,
        })
        .from(taskResolutionState)
        .where(
          and(
            eq(taskResolutionState.originRule, originRule),
            eq(taskResolutionState.dedupeKey, dedupeKey)
          )
        )
        .limit(1);

      return result[0] ?? null;
    },

    async insertTask(draft: SystemTaskDraft) {
      const result = await tenantDb.insert(tasks).values(taskDraftValues(draft) as any).returning();
      return mapDrizzleTaskRow(result[0]);
    },

    async updateTask(taskId: string, draft: SystemTaskDraft) {
      const result = await tenantDb
        .update(tasks)
        .set(taskDraftValues(draft) as any)
        .where(eq(tasks.id, taskId))
        .returning();

      return mapDrizzleTaskRow(result[0]);
    },
  };
}
