import { pgTable, uuid, timestamp, index } from "drizzle-orm/pg-core";

// Per-office (cloned into every office_* schema). Durable, server-set ownership ledger for corrective-action
// RESPONSE-photo uploads: confirmCorrectiveActionUpload inserts one row per file it creates. discard gates on
// an EXISTS here (file_id + scorecard_id) instead of the FORGEABLE original_filename prefix — the generic
// upload/update API can set a caller-supplied filename but never writes THIS table. The FKs (file_id ->
// files ON DELETE CASCADE as the PK; scorecard_id -> field_scorecards ON DELETE CASCADE) are owned by
// migration 0195; Drizzle keeps bare uuid columns to match the field-scorecards / corrective-action convention.
export const scorecardCorrectiveActionUploads = pgTable(
  "scorecard_corrective_action_uploads",
  {
    fileId: uuid("file_id").primaryKey(),
    scorecardId: uuid("scorecard_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("scorecard_corrective_action_uploads_scorecard_idx").on(table.scorecardId),
  ],
);
