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
    // Backs the rfp_bidboard_create sweeps' correlated per-deal lookups (worker/src/jobs/rfp-bidboard-create.ts):
    // dead-create EXISTS / live-retry NOT EXISTS / surfaced-error subquery, all keyed on office_id +
    // payload->>'dealId' + status and ordered by created_at DESC. Partial on this job type to stay small.
    index("job_queue_rfp_bidboard_create_deal_idx")
      .on(
        table.officeId,
        sql`(payload->>'dealId')`,
        table.status,
        sql`created_at DESC`
      )
      .where(sql`job_type = 'rfp_bidboard_create'`),
    // Backs the AI-report stale-run sweep (server/src/modules/field/ai-report-runs.ts), which decides
    // whether a QUEUED run is abandoned by asking whether a live delivery still exists for it. Partial on
    // this job type AND the two live statuses, so it holds only in-flight AI-report deliveries and rows
    // leave it the moment they reach a terminal status.
    index("job_queue_ai_report_run_idx")
      .on(sql`(payload->>'runId')`)
      .where(sql`job_type = 'ai_report_generation' AND status IN ('pending', 'processing')`),
    // Backs findGlassesWalkthroughForwardJobState (server/src/modules/walkthrough-capture/
    // glasses-walkthrough-service.ts), which runs on every walk-completion call — including every mobile
    // background retry of one — and answers both "is a forward already scheduled for this walk on this
    // deal?" and "did a dead row learn a TROCK Scope checkpoint we must inherit?" in a single scan.
    // Keyed on the PAIR because a phone-minted walkId is not unique across deals.
    //
    // Deliberately NOT partial on status, unlike the two above: this lookup must read DEAD rows, because
    // the dead row is where the inherited checkpoint lives — and every forward costs a real transcription
    // plus a real scope extraction, so missing that checkpoint bills twice. Mirrors migration 0211.
    index("job_queue_glasses_walkthrough_forward_idx")
      .on(sql`(payload->>'walkId')`, sql`(payload->>'dealId')`)
      .where(sql`job_type = 'glasses_walkthrough_forward'`),
  ]
);
