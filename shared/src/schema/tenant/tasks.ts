import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  date,
  time,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "../public/offices.js";
import { TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../../types/enums.js";

export const taskTypeEnum = pgEnum("task_type", TASK_TYPES);
export const taskPriorityEnum = pgEnum("task_priority", TASK_PRIORITIES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    type: taskTypeEnum("type").notNull(),
    priority: taskPriorityEnum("priority").default("normal").notNull(),
    status: taskStatusEnum("status").default("pending").notNull(),
    assignedTo: uuid("assigned_to").notNull(),
    createdBy: uuid("created_by"),
    officeId: uuid("office_id").references(() => offices.id),
    originRule: varchar("origin_rule", { length: 120 }),
    sourceRule: varchar("source_rule", { length: 120 }),
    sourceEvent: varchar("source_event", { length: 120 }),
    dedupeKey: varchar("dedupe_key", { length: 255 }),
    reasonCode: varchar("reason_code", { length: 120 }),
    entitySnapshot: jsonb("entity_snapshot"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    waitingOn: jsonb("waiting_on"),
    blockedBy: jsonb("blocked_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    emailId: uuid("email_id"),
    dueDate: date("due_date"),
    dueTime: time("due_time"),
    remindAt: timestamp("remind_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    isOverdue: boolean("is_overdue").default(false).notNull(),
    isTestData: boolean("is_test_data").default(false).notNull(),
    // Who created this task: a person, or the system. No pre-existing column could answer it --
    // `type` is 'manual' on both a hand-typed task and the AI-disconnect cron's output, and
    // `created_by` holds a real human on two machine paths. Migration 0233; DEFAULT 'automated' there
    // only covers the deploy window, so every write site sets this explicitly.
    source: varchar("source", { length: 20 }).default("automated").notNull(),
    // ---- Closed loop (migration 0234) -----------------------------------------------------------
    // Denormalised head of the task's thread, so "who has unread replies" is one indexed predicate
    // instead of a correlated MAX() over task_comments on every list render.
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    lastReplyBy: uuid("last_reply_by"),
    /**
     * How far up the thread the ASSIGNER has confirmed reading -- MONOTONIC, never cleared.
     *
     * A design that cleared this on every new reply would make `assigner_ack_at < last_reply_at`
     * unreachable (ack only ever writes a timestamp >= the reply it acks), so the "a reply after an
     * ack re-raises the task" rule would be carried entirely by the IS NULL branch and the comparison
     * could be mutated away without a single test noticing. Keeping it monotonic and having the ack
     * carry the timestamp the client actually rendered makes the comparison load-bearing AND closes
     * the read-modify-write race where a reply landing mid-ack is marked seen forever.
     */
    assignerAckAt: timestamp("assigner_ack_at", { withTimezone: true }),
    /**
     * WHO last handed this task to somebody (migration 0240).
     *
     * NULL means it has NEVER been reassigned — in which case the assigner is `createdBy`, because
     * until a task changes hands the person who created it is the person who assigned it. Readers
     * resolve `COALESCE(lastAssignedBy, createdBy)`; nothing reads this column bare.
     *
     * Three columns on this table answer three different questions, and they are spelled out here
     * because `created_by` / `origin_rule` / `type` each half-answering "where did this come from" is
     * why 0233 existed:
     *     createdBy        who typed it into existence. Never moves.
     *     assignedAt       WHEN it last changed hands (0239, feat/task-assignment-modal).
     *     lastAssignedBy   WHO last handed it over.
     * Written at the same sites as `assignedAt` so the pair cannot disagree about whether an
     * assignment happened.
    */
    lastAssignedBy: uuid("last_assigned_by"),

    /**
     * When this task last CHANGED HANDS — set at creation and re-stamped whenever `assigned_to` moves.
     *
     * It exists because acknowledgement is keyed (task, user) and therefore cannot say WHICH assignment
     * was acknowledged. Without a moment to compare against, a task handed back to a prior assignee is
     * silently covered by the acknowledgement they gave the first time, and a task handed back to its
     * own author is indistinguishable from one they wrote for themselves. An ack counts only when it is
     * at least as recent as the assignment it is supposed to answer. Migration 0239.
     */
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("tasks_assigned_status_idx").on(table.assignedTo, table.status, table.dueDate),
    index("tasks_priority_idx").on(table.assignedTo, table.status, table.priority),
    index("tasks_status_scheduled_for_idx").on(table.status, table.scheduledFor),
    uniqueIndex("tasks_active_origin_rule_dedupe_key_uidx")
      .on(table.originRule, table.dedupeKey)
      .where(
        sql`${table.originRule} IS NOT NULL AND ${table.dedupeKey} IS NOT NULL AND ${table.status} IN ('scheduled', 'pending', 'in_progress', 'waiting_on', 'blocked')`
      ),
    index("tasks_origin_rule_reason_code_idx").on(table.originRule, table.reasonCode),
    // Touch index mirroring activities_contact_idx — makes the contacts last_touch_at sort's
    // MAX(tasks.updated_at) subquery an Index Only Scan instead of a Seq Scan. Source-of-truth marker;
    // migration 0166 builds it per-office as PARTIAL (WHERE contact_id IS NOT NULL) + updated_at DESC.
    index("tasks_contact_updated_at_idx").on(table.contactId, table.updatedAt),
    // Serves the per-source task tabs: assigned_to scopes the list, source is the tab, status/due_date
    // carry the bucket predicates. Source-of-truth marker; migration 0233 builds it per-office, and the
    // runner's pre-step builds it CONCURRENTLY so API boot never blocks task writes on it.
    index("tasks_assigned_source_status_idx").on(table.assignedTo, table.source, table.status, table.dueDate),
    // Serves /tasks/awaiting-me: "tasks I assigned that have a reply I have not acknowledged".
    // Scoped by the RESOLVED assigner -- see lastAssignedBy above. Source-of-truth marker; migration 0240
    // builds it per-office over the COALESCE(last_assigned_by, created_by) EXPRESSION and PARTIAL on
    // the unacked condition, so both the resolution and the predicate are answered BY the index rather
    // than filtered after it. Drizzle's index() can express neither, hence the divergence -- 0240's
    // SQL is authoritative. 0234's creator-scoped index is dropped there.
    index("tasks_assigner_awaiting_ack_idx").on(table.lastAssignedBy, table.lastReplyAt),
  ]
);
