import { pgTable, uuid, timestamp, index, unique } from "drizzle-orm/pg-core";

/**
 * One row per (task, person): the login modal has shown this person this assignment.
 *
 * Per PERSON, not per task, and that is the whole reason this is a table rather than a column on
 * `tasks`. A task reassigned from Alice to Bob has been seen by Alice and not by Bob; a boolean on the
 * task row can only hold one of those answers. It is server-side rather than sessionStorage because it
 * has to survive a new device, a cleared profile and a second browser -- this is an accountability
 * feature, so "I never saw it" has to be answerable from the database.
 *
 * ABSENCE OF A ROW MEANS "NEVER SHOWN", which is why migration 0235 seeds this table for every task
 * that was already pending at deploy time. Urgent/high/overdue assignments re-show regardless of the
 * row until they leave status 'pending'. Migration 0235.
 */
export const taskAssignmentAcknowledgements = pgTable(
  "task_assignment_acknowledgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull(),
    userId: uuid("user_id").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Every acknowledgement write is an ON CONFLICT DO NOTHING against this constraint, so a
    // double-click, a StrictMode double-invoke and a retried request all collapse to one row.
    unique("task_assignment_ack_uq").on(table.taskId, table.userId),
    index("task_assignment_ack_user_idx").on(table.userId, table.acknowledgedAt),
  ]
);
