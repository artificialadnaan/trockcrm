import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, offices } from "../public/index.js";

export const callRecordings = pgTable(
  "call_recordings",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => offices.id),
    uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    originalFilename: text("original_filename").notNull(),
    r2Key: text("r2_key").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    durationSeconds: integer("duration_seconds"),
    title: text("title"),
    notes: text("notes"),
    callDate: timestamp("call_date", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    transcriptionStatus: text("transcription_status").default("none").notNull(),
    transcriptionError: text("transcription_error"),
    transcriptText: text("transcript_text"),
    transcriptSummary: text("transcript_summary"),
  },
  (table) => [
    check("call_recordings_entity_type_check", sql`${table.entityType} IN ('deal', 'lead', 'company', 'contact')`),
    check("call_recordings_transcription_status_check", sql`${table.transcriptionStatus} IN ('none', 'pending', 'processing', 'complete', 'failed')`),
    index("idx_call_recordings_entity").on(table.entityType, table.entityId).where(sql`${table.deletedAt} IS NULL`),
    index("idx_call_recordings_expires").on(table.expiresAt).where(sql`${table.deletedAt} IS NULL`),
    index("idx_call_recordings_tenant").on(table.tenantId, table.uploadedAt).where(sql`${table.deletedAt} IS NULL`),
  ]
);
