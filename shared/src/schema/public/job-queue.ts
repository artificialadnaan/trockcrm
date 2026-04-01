import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  jsonb,
  integer,
  text,
  timestamp,
  bigserial,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "./offices.js";
import { JOB_STATUSES } from "../../types/enums.js";

export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);

export const jobQueue = pgTable(
  "job_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobType: varchar("job_type", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    officeId: uuid("office_id").references(() => offices.id),
    status: jobStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    lastError: text("last_error"),
    startedProcessingAt: timestamp("started_processing_at", { withTimezone: true }),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("job_queue_pending_idx")
      .on(table.status, table.runAfter)
      .where(sql`status = 'pending'`),
  ]
);
