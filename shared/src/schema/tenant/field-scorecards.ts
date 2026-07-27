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
    // The field_responders roster person the field user PICKED for each role from the scorecard dropdown (null
    // when the name was typed free-text, or nothing was picked). Separate from the display names above: recipient
    // resolution PREFERS this link (roster email at send time), falling back to the deal's Team-tab super/PM when
    // null. Bare uuid — the FK -> field_responders(id) ON DELETE SET NULL lives in migration 0199.
    superintendentResponderId: uuid("superintendent_responder_id"),
    pmResponderId: uuid("pm_responder_id"),
    /** 1 = original 100-point form; 2 = eight 1-10 categories with an average. */
    formVersion: smallint("form_version").default(1).notNull(),
    /** Discriminates the scorecard KIND sharing these tables: 'project' (default) | 'leadership'.
     *  `text` to match migration 0183, which also carries CHECK (kind IN ('project','leadership')). */
    kind: text("kind").default("project").notNull(),
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
    // varchar(30) (migration 0192) fits the corrective-action stage values: 'corrective_action_open' (22),
    // 'corrective_action_closed' (24). Legacy value is 'submitted'.
    status: varchar("status", { length: 30 }).default("submitted").notNull(),
    submittedBy: uuid("submitted_by").notNull(),
    submittedByName: text("submitted_by_name"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    pdfR2Key: text("pdf_r2_key"),
    pdfR2Bucket: text("pdf_r2_bucket"),
    pdfGeneratedAt: timestamp("pdf_generated_at", { withTimezone: true }),
    /** Renderer revision used for the stored PDF artifact. Version 1 covers legacy/unversioned PDFs. */
    pdfRenderVersion: smallint("pdf_render_version").default(1).notNull(),
    /**
     * The scorecard `updated_at` the stored PDF artifact was rendered from (migration 0200). Written in the
     * same guarded CAS UPDATE that publishes pdf_r2_key. needsScorecardPdfRegeneration compares it against
     * the live updated_at, so any content change — including a corrective-action response — invalidates the
     * cached artifact. NULL on every pre-migration row, which reads as stale.
     */
    pdfContentGeneration: timestamp("pdf_content_generation", { withTimezone: true }),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    // Idempotency stamp for the below-band corrective-action notification (migration 0193). Mirrors
    // email_sent_at: the scorecard_corrective_action_email worker handler stamps this once after sending to
    // ALL recipients in one run, and skips if it's already set — so a job retry never re-notifies.
    correctiveActionEmailSentAt: timestamp("corrective_action_email_sent_at", { withTimezone: true }),
    // The ACTIVE corrective-action notification cycle's nonce (migration 0197). Set to the SAME cycleNonce
    // enqueued on every fresh cycle (reconcile transition-into-open / already-open-gained-work, AND
    // restartCorrectiveActionNotificationCycleForDeal) in the same transaction. The worker's final delivery
    // stamp requires the job's payload.cycleNonce to still match this — so a stale-cycle job (whose cycle was
    // superseded by an edit/team-mutation before it stamped) updates 0 rows and does NOT stamp, and the
    // current cycle's matching-nonce job stamps. Nullable: legacy cards + legacy in-flight jobs (no payload
    // nonce) fall back to the pre-guard stamp behavior.
    correctiveActionCycleNonce: uuid("corrective_action_cycle_nonce"),
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
    // Nullable as of migration 0193: a corrective-action RESPONSE photo carries corrective_action_id and has
    // section_key/deficiency_key null (spec §4.3). Original scorecard-evidence photos always set section_key.
    sectionKey: varchar("section_key", { length: 40 }),
    /** V2 critical-deficiency evidence is attached to the exact selected deficiency. */
    deficiencyKey: varchar("deficiency_key", { length: 40 }),
    // Set on corrective-action RESPONSE photos (FK -> scorecard_corrective_actions ON DELETE CASCADE, owned by
    // migration 0192); null for original scorecard evidence. Bare uuid here (no .references()) to keep the
    // field-scorecards convention — the migration owns the FK. CASCADE (not SET NULL): when a corrective-action
    // row is deleted (a removed flag's row is purged on edit), its RESPONSE-photo LINK rows go with it, so a
    // null-corrective_action_id row is never left behind to be mis-read as original section evidence.
    correctiveActionId: uuid("corrective_action_id"),
    fileId: uuid("file_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("field_scorecard_photos_card_file_key").on(table.scorecardId, table.fileId),
    index("field_scorecard_photos_card_idx").on(table.scorecardId),
  ],
);

/**
 * Durable ownership/state ledger for photos created while editing an already-submitted scorecard.
 *
 * This is deliberately separate from `files.tags`: tags are user-editable gallery metadata, while this
 * row is a server-owned authorization/tombstone record. A globally unique client upload id can therefore
 * never be replayed against another scorecard, and a discard that wins a race with confirm-upload remains
 * durable across app/server restarts.
 */
export const fieldScorecardEditUploads = pgTable(
  "field_scorecard_edit_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scorecardId: uuid("scorecard_id").notNull(),
    dealId: uuid("deal_id").notNull(),
    clientUploadId: varchar("client_upload_id", { length: 64 }).notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    fileId: uuid("file_id"),
    /** authorized -> confirmed -> linked; discard may move authorized/confirmed -> discarded. */
    state: varchar("state", { length: 20 }).default("authorized").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("field_scorecard_edit_uploads_client_upload_key").on(table.clientUploadId),
    index("field_scorecard_edit_uploads_card_idx").on(table.scorecardId),
    index("field_scorecard_edit_uploads_file_idx").on(table.fileId),
  ],
);
