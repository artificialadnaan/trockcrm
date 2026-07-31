import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "./offices.js";
import { users } from "./users.js";

/**
 * One row per "AI Report" tap on the T Rock Cam Build-report screen: the status surface the phone polls while
 * a Claude vision pass authors the executive summary and per-photo findings behind a job_queue job.
 *
 * PUBLIC (not per-office) so the status endpoint can resolve a run id to its office without fanning out
 * across every tenant schema — same reasoning as public.bid_board_ingestion_inbox and public.job_queue.
 * dealId/fileId therefore carry NO foreign key: both live in office_<slug>.
 *
 * Kept byte-aligned with migration 0209 (field_ai_report_runs) — the raw SQL is the source of truth for prod;
 * this drizzle definition exists for drizzle-kit parity and typed reads (mirrors bid_board_ingestion_inbox).
 */
export const fieldAiReportRuns = pgTable(
  "field_ai_report_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // office_<slug>.deals.id — no .references(): the deals table is per-office, unreachable from public.
    dealId: uuid("deal_id").notNull(),
    officeId: uuid("office_id")
      .references(() => offices.id)
      .notNull(),
    // Resolved once at enqueue. The report's R2 key is built from this, so re-deriving it later must not
    // depend on whatever office the polling request happens to be scoped to.
    officeSlug: text("office_slug").notNull(),
    requestedBy: uuid("requested_by")
      .references(() => users.id)
      .notNull(),
    // The selection in PRINT ORDER. The model is handed the photographs in this exact sequence and returns
    // findings indexed against it, so re-sorting this array would silently mis-caption every photo.
    photoIds: uuid("photo_ids").array().notNull(),
    reportTitle: text("report_title"),
    // Optional free-text scope from the requester. Drives both the executive summary's subject and what the
    // per-photo findings are allowed to raise, so it is the main lever against an off-topic report.
    focusPrompt: text("focus_prompt"),
    status: text("status").default("queued").notNull(),
    // office_<slug>.files.id of the rendered PDF — no .references() (per-office table).
    fileId: uuid("file_id"),
    error: text("error"),
    // Usage/cost telemetry, mirroring worker/src/jobs/call-recording-transcribe.ts. Recorded even when the run
    // later fails, so a run that dies during PDF render is still attributable to the spend it already incurred.
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One in-flight run per (project, requester) — the DB-enforced guard against a double-tap buying a
    // second Claude pass. Partial, so completed runs never collide (migration 0209).
    uniqueIndex("field_ai_report_runs_inflight_uidx")
      .on(table.dealId, table.requestedBy)
      .where(sql`${table.status} IN ('queued', 'running')`),
    // Backs the rolling daily cap, which counts a requester's runs in the last 24 hours across EVERY status
    // and so cannot use the partial index above. Declared here as well as in 0209 because drizzle.config.ts
    // treats this file as the DESIRED database definition: an index present only in the migration reads as
    // drift, and the generated diff would drop the one thing keeping that query bounded on a ledger that is
    // never pruned.
    index("field_ai_report_runs_requester_recent_idx").on(table.requestedBy, table.createdAt.desc()),
    // Bounds the per-report model spend at the DB, mirroring AI_REPORT_MAX_PHOTOS in the route.
    check("field_ai_report_runs_photo_ids_check", sql`cardinality(${table.photoIds}) BETWEEN 1 AND 60`),
    // Mirror migration 0209's inline CHECK (status IN (...)). Named to match Postgres's auto-name for the
    // column check so drizzle-kit sees parity instead of generating a drift migration that drops it.
    check(
      "field_ai_report_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
  ]
);
