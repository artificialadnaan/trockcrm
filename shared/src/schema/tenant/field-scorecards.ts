import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  numeric,
  smallint,
  boolean,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Per-office (cloned into every office_* schema). Foreign keys, ON DELETE CASCADE, and the
// cross-schema deals(id) reference are defined in migration 0172 (matching the closeout-checklist /
// files convention where the migration owns FKs and Drizzle keeps bare uuid columns).

export const fieldScorecards = pgTable(
  "field_scorecards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Client-generated, stable across offline retries; the unique index makes submit idempotent.
    clientSubmissionId: uuid("client_submission_id").notNull(),
    dealId: uuid("deal_id").notNull(),
    weekOf: date("week_of").notNull(),
    projectNumber: text("project_number"),
    superintendentName: text("superintendent_name"),
    pmName: text("pm_name"),
    /** 1 = original 100-point form; 2 = eight 1-10 categories with an average. */
    formVersion: smallint("form_version").default(1).notNull(),
    /** Discriminates the scorecard KIND sharing these tables: 'project' (default) | 'leadership'. */
    kind: varchar("kind", { length: 20 }).default("project").notNull(),
    /** V2's authoritative score. `totalScore` remains average * 10 for legacy rollups. */
    averageScore: numeric("average_score", { precision: 3, scale: 1 }),
    /** Leadership Project Summary free text (voice-dictatable). */
    summary: text("summary"),
    superintendentSignature: text("superintendent_signature"),
    pmSignature: text("pm_signature"),
    totalScore: integer("total_score").notNull(),
    rating: varchar("rating", { length: 40 }).notNull(),
    criticalDeficiencies: text("critical_deficiencies").array().default([]).notNull(),
    /** V2 supplemental description keyed by critical-deficiency key. */
    criticalDeficiencyNotes: jsonb("critical_deficiency_notes").$type<Record<string, string>>().default({}).notNull(),
    actionItems: text("action_items").array().default([]).notNull(),
    status: varchar("status", { length: 20 }).default("submitted").notNull(),
    submittedBy: uuid("submitted_by").notNull(),
    submittedByName: text("submitted_by_name"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    pdfR2Key: text("pdf_r2_key"),
    pdfR2Bucket: text("pdf_r2_bucket"),
    pdfGeneratedAt: timestamp("pdf_generated_at", { withTimezone: true }),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("field_scorecards_client_submission_id_key").on(table.clientSubmissionId),
    index("field_scorecards_deal_idx").on(table.dealId, table.submittedAt),
    index("field_scorecards_submitted_at_idx").on(table.submittedAt),
  ],
);

export const fieldScorecardItems = pgTable(
  "field_scorecard_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scorecardId: uuid("scorecard_id").notNull(),
    sectionKey: varchar("section_key", { length: 40 }).notNull(),
    points: integer("points").notNull(),
    note: text("note"),
  },
  (table) => [
    uniqueIndex("field_scorecard_items_card_section_key").on(table.scorecardId, table.sectionKey),
  ],
);

export const fieldScorecardPhotos = pgTable(
  "field_scorecard_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scorecardId: uuid("scorecard_id").notNull(),
    sectionKey: varchar("section_key", { length: 40 }).notNull(),
    /** V2 critical-deficiency evidence is attached to the exact selected deficiency. */
    deficiencyKey: varchar("deficiency_key", { length: 40 }),
    fileId: uuid("file_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("field_scorecard_photos_card_file_key").on(table.scorecardId, table.fileId),
    index("field_scorecard_photos_card_idx").on(table.scorecardId),
  ],
);
