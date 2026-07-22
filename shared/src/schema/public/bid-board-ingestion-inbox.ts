import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "./offices.js";

/**
 * Durable inbox for Bid Board → CRM ingestion. Decouples fast/idempotent ACCEPTANCE from async PROCESSING
 * so a slow import can't produce a false upstream 502 or duplicate concurrent imports.
 *
 * Kept byte-aligned with migration 0188 (bid_board_ingestion_inbox) — the raw SQL is the source of truth
 * for prod; this drizzle definition exists for drizzle-kit parity and typed reads (mirrors job_queue).
 */
export const bidBoardIngestionInbox = pgTable(
  "bid_board_ingestion_inbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    officeSlug: text("office_slug").notNull(),
    officeId: uuid("office_id").references(() => offices.id),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").notNull(),
    rowCount: integer("row_count").default(0).notNull(),
    sourceFilename: text("source_filename"),
    // The scrape's snapshot timestamp (payload.provenance.extractedAt). Drives the monotonic per-office guard
    // that skips a stale snapshot so an older retry can't overwrite newer Bid Board mirror data (migration 0188).
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    status: text("status").default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    runId: uuid("run_id"),
    metrics: jsonb("metrics"),
    warningsCount: integer("warnings_count"),
    lastError: text("last_error"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // In-flight lease/heartbeat (migration 0188): set + renewed while an import runs so a concurrent claimant
    // can only re-claim a 'processing' row whose lease has expired. Kept in the schema so db:generate can't
    // treat the column as absent and drift.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // Per-row dead-letter alert marker (migration 0190): stamped once when the heartbeat cron emails the
    // dead-letter alert for a 'failed' row, so a timestamp watermark can't skip an out-of-order commit.
    deadLetterAlertedAt: timestamp("dead_letter_alerted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("bid_board_ingestion_inbox_office_hash_uidx").on(table.officeSlug, table.payloadHash),
    index("bid_board_ingestion_inbox_office_status_idx").on(table.officeSlug, table.status),
    // Supports the monotonic guard's MAX(extracted_at) lookup over the office's 'succeeded' rows (migration 0188).
    index("bid_board_ingestion_inbox_office_extracted_idx")
      .on(table.officeSlug, table.extractedAt.desc())
      .where(sql`${table.status} = 'succeeded'`),
    // Serves the heartbeat dead-letter sweep's exact predicate (migration 0190); tiny — a stamped or
    // non-'failed' row drops out of it.
    index("bid_board_ingestion_inbox_dead_letter_idx")
      .on(table.officeSlug, table.finishedAt)
      .where(sql`${table.status} = 'failed' AND ${table.deadLetterAlertedAt} IS NULL`),
    // Mirror migration 0188's inline CHECK (status IN (...)). Named to match Postgres's auto-name for the
    // column check so drizzle-kit sees parity instead of generating a drift migration that drops it.
    check(
      "bid_board_ingestion_inbox_status_check",
      sql`${table.status} IN ('queued', 'processing', 'succeeded', 'failed')`,
    ),
  ]
);
