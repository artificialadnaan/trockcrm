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
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("bid_board_ingestion_inbox_office_hash_uidx").on(table.officeSlug, table.payloadHash),
    index("bid_board_ingestion_inbox_office_status_idx").on(table.officeSlug, table.status),
    // Mirror migration 0188's inline CHECK (status IN (...)). Named to match Postgres's auto-name for the
    // column check so drizzle-kit sees parity instead of generating a drift migration that drops it.
    check(
      "bid_board_ingestion_inbox_status_check",
      sql`${table.status} IN ('queued', 'processing', 'succeeded', 'failed')`,
    ),
  ]
);
