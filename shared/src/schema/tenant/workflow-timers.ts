import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  timestamp,
} from "drizzle-orm/pg-core";

export const workflowTimerTypeEnum = pgEnum("workflow_timer_type", [
  "proposal_response",
  "estimate_review",
  "companycam_service",
  "final_billing",
  "custom",
]);

export const workflowTimerStatusEnum = pgEnum("workflow_timer_status", [
  "active",
  "completed",
  "expired",
  "cancelled",
]);

export const workflowTimers = pgTable("workflow_timers", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  timerType: workflowTimerTypeEnum("timer_type").notNull(),
  label: varchar("label", { length: 255 }),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: workflowTimerStatusEnum("status").default("active").notNull(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
