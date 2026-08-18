import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { deals } from "./deals.js";
import { files } from "./files.js";

// Per-office (cloned into every office_* schema). The client-facing weekly progress report:
// superintendents author it in T-Rock Cam, PMs review it, clients receive an email with a durable link
// and a PDF. Migration 0222 owns the DDL; this file mirrors it so `db:generate` sees parity rather than
// drift, and so the PGlite runtime tests build their schema from the SAME definitions prod is generated
// from (server/tests/helpers/tenant-schema-from-drizzle.ts).
//
// Keep this file and 0222 in lockstep. A column that exists here but not in the migration produces tests
// that pass against a schema production does not have.

/**
 * The setup row — one live row per deal. Everything is editable from the CRM dashboard because PMs and
 * superintendents get swapped mid-project and the report has to follow them.
 */
export const weeklyReportProjects = pgTable(
  "weekly_report_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    /** Defaults from the deal's property but stays independently editable — the reference report prints
     *  "4123 Cedar Springs", which is not necessarily how the deal is named in the CRM. */
    propertyDisplayName: text("property_display_name"),
    clientName: text("client_name"),
    /** Client-side roles as they appear on the report. Name + optional email rather than a CRM contact
     *  reference: RM and CM are blank on most real reports, and requiring a contact record to exist would
     *  block setup on data the CRM has no reason to hold. The emails seed the send modal's recipient list. */
    clientDocName: text("client_doc_name"),
    clientDocEmail: text("client_doc_email"),
    clientPmName: text("client_pm_name"),
    clientPmEmail: text("client_pm_email"),
    clientRmName: text("client_rm_name"),
    clientRmEmail: text("client_rm_email"),
    clientCmName: text("client_cm_name"),
    clientCmEmail: text("client_cm_email"),
    /** BARE uuids: the FK targets `public.users`, outside this tenant schema, so it is declared in
     *  migration 0222 (ON DELETE SET NULL) rather than here — Drizzle would otherwise emit it against a
     *  tenant-local `users` table that does not exist. Same convention as glasses-walkthroughs.ts. */
    trockPmUserId: uuid("trock_pm_user_id"),
    trockSuperUserId: uuid("trock_super_user_id"),
    contractDate: date("contract_date"),
    /** The `*_note` columns render in place of a missing date. The reference report prints "TBD Permit"
     *  where the start and completion dates belong; a nullable date plus a note keeps date arithmetic
     *  (remaining weeks, cadence bounds) working while still printing the words the PM wants. */
    contractDateNote: text("contract_date_note"),
    projectStartDate: date("project_start_date"),
    projectStartDateNote: text("project_start_date_note"),
    projectCompletionDate: date("project_completion_date"),
    projectCompletionDateNote: text("project_completion_date_note"),
    projectedDurationWeeks: integer("projected_duration_weeks"),
    /** 0=Sunday .. 6=Saturday, matching BOTH Postgres EXTRACT(DOW) and JS getDay() so the reminder SQL
     *  and the client's date maths agree without a translation layer. */
    cadenceWeekday: smallint("cadence_weekday").notNull(),
    cadenceStartDate: date("cadence_start_date").notNull(),
    cadenceEndDate: date("cadence_end_date"),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // A deal has at most one LIVE setup. Partial, so a soft-deleted row keeps its history without
    // blocking a later re-create for the same deal.
    uniqueIndex("weekly_report_projects_deal_uidx")
      .on(table.dealId)
      .where(sql`is_active`),
    index("weekly_report_projects_status_idx")
      .on(table.status, table.cadenceWeekday)
      .where(sql`is_active`),
    index("weekly_report_projects_super_idx").on(table.trockSuperUserId).where(sql`is_active`),
    index("weekly_report_projects_pm_idx").on(table.trockPmUserId).where(sql`is_active`),
    check("weekly_report_projects_status_check", sql`${table.status} in ('active', 'paused', 'completed')`),
    check("weekly_report_projects_weekday_check", sql`${table.cadenceWeekday} between 0 and 6`),
    check(
      "weekly_report_projects_duration_check",
      sql`${table.projectedDurationWeeks} is null or ${table.projectedDurationWeeks} >= 0`,
    ),
    check(
      "weekly_report_projects_cadence_range",
      sql`${table.cadenceEndDate} is null or ${table.cadenceEndDate} >= ${table.cadenceStartDate}`,
    ),
  ],
);

/**
 * One report per project per week per version.
 */
export const weeklyReports = pgTable(
  "weekly_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The phone's idempotency key, same contract as field_scorecards.client_submission_id: a submit
     *  retried over flaky jobsite LTE must not produce a second report for the same week. */
    clientSubmissionId: uuid("client_submission_id").notNull().unique(),
    weeklyReportProjectId: uuid("weekly_report_project_id")
      .notNull()
      .references(() => weeklyReportProjects.id, { onDelete: "cascade" }),
    /** Denormalised from the project row so photo-window and office-wide queries do not have to join
     *  through weekly_report_projects on every read. */
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    /** The cadence DUE DATE for the week, not the Monday and not the authoring date. The reference report
     *  is headed "Week of 8/13/26" — a Thursday — because that project's cadence is Thursday. */
    weekOf: date("week_of").notNull(),
    version: integer("version").default(1).notNull(),
    /** Set on the ORIGINAL when a correction is issued, pointing at the replacement. A sent report is
     *  immutable, so a fix is a new version rather than an edit — the client may have saved the old link. */
    supersededById: uuid("superseded_by_id"),
    /** Strict ladder: draft -> pending_review -> approved -> sent. The CHECK bounds the domain only;
     *  legal TRANSITIONS are enforced in the service layer, which a CHECK cannot express. */
    status: varchar("status", { length: 20 }).default("draft").notNull(),
    workCompleted: text("work_completed"),
    nextWeekLookAhead: text("next_week_look_ahead"),
    issuesConcerns: text("issues_concerns"),
    completionPercent: numeric("completion_percent", { precision: 5, scale: 2 }),
    weatherDelayDays: integer("weather_delay_days"),
    /** Computed at submit from projected duration and weeks elapsed, then STORED — so a report sent in
     *  August still reports August's arithmetic after the projected duration is revised in September. */
    remainingWeeks: integer("remaining_weeks"),
    projectedDurationWeeks: integer("projected_duration_weeks"),
    /** The whole header block (client, client team, T-Rock team, schedule dates and notes) frozen at send.
     *  The live project row drives the NEXT report; a sent report reads its own snapshot. Without this,
     *  swapping a PM rewrites the contact details on every report already delivered. */
    snapshot: jsonb("snapshot"),
    authoredBy: uuid("authored_by"),
    authoredAt: timestamp("authored_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    sentBy: uuid("sent_by"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    pdfR2Key: text("pdf_r2_key"),
    pdfR2Bucket: text("pdf_r2_bucket"),
    pdfGeneratedAt: timestamp("pdf_generated_at", { withTimezone: true }),
    /** The CONTENT GENERATION the stored bytes were rendered from, captured before the render started —
     *  not when they finished. Staleness is decided against this, never against pdfGeneratedAt: before send
     *  the generation covers rows (the setup row, the named users, the selected files) that move without
     *  touching updatedAt, so a wall-clock stamp taken after the render silently swallows anything that
     *  changed while it ran. Added by 0224; see pdf-artifact.ts. */
    pdfContentGeneration: timestamp("pdf_content_generation", { withTimezone: true }),
    pdfRenderVersion: integer("pdf_render_version").default(0).notNull(),
    /** Surfaced as a "Send failed" chip with retry. The scorecard email path is fire-and-forget; here a
     *  silent failure means a client never received their report and nobody finds out. */
    sendAttempts: integer("send_attempts").default(0).notNull(),
    sendError: text("send_error"),
    /** Migration 0226. The composed email the PM approved — recipients, subject, the paragraph they
     *  edited, the attach-PDF choice and the share URL. Stored because a retry must re-send THE SAME
     *  message, and because the raw share token exists exactly once (only its hash is kept) so the link
     *  is unrecoverable if it is not carried here. */
    sendRequest: jsonb("send_request"),
    /** Migration 0226. Rotates the mail provider's idempotency key, per send request. A retry reuses it
     *  (so a crash between "provider accepted" and the stamp cannot double-send); a correction is a new
     *  report row and gets its own. */
    sendDeliveryKey: uuid("send_delivery_key"),
    /** Migration 0226. When the provider ACCEPTED the message. Distinct from `sentAt`, which is stamped
     *  when the PM commits — the dashboard's counters read `status`, so `sentAt` cannot wait on a mail
     *  server, and a report that claims delivery the instant a button was clicked hides the failure this
     *  feature exists to surface. */
    sendDeliveredAt: timestamp("send_delivered_at", { withTimezone: true }),
    /** Migration 0226. `sendAttempts` alone cannot tell "failed twice an hour ago and gave up" from
     *  "failed twice in the last minute and is still retrying". */
    sendLastAttemptAt: timestamp("send_last_attempt_at", { withTimezone: true }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("weekly_reports_project_week_version_uidx")
      .on(table.weeklyReportProjectId, table.weekOf, table.version)
      .where(sql`is_active`),
    index("weekly_reports_project_week_idx").on(table.weeklyReportProjectId, table.weekOf.desc()),
    index("weekly_reports_deal_idx").on(table.dealId, table.weekOf.desc()),
    index("weekly_reports_status_idx").on(table.status, table.weekOf.desc()).where(sql`is_active`),
    // Migration 0226. The "Send failed" row set: committed to the client but not proven delivered.
    index("weekly_reports_send_undelivered_idx")
      .on(table.weeklyReportProjectId, table.weekOf)
      .where(sql`is_active AND status = 'sent' AND send_delivered_at IS NULL`),
    check(
      "weekly_reports_status_check",
      sql`${table.status} in ('draft', 'pending_review', 'approved', 'sent')`,
    ),
    check("weekly_reports_version_check", sql`${table.version} >= 1`),
    check(
      "weekly_reports_completion_percent_check",
      sql`${table.completionPercent} is null or (${table.completionPercent} >= 0 and ${table.completionPercent} <= 100)`,
    ),
    check(
      "weekly_reports_weather_delay_check",
      sql`${table.weatherDelayDays} is null or ${table.weatherDelayDays} >= 0`,
    ),
  ],
);

/**
 * Photos selected onto a report, with a REPORT-SPECIFIC caption.
 *
 * `caption` is deliberately not `files.description`. Editing a caption for the weekly report must not
 * rewrite the description the crew typed at capture time — a stated product requirement. Keeping the
 * caption on the link row makes that structural: there is no code path here that could write through,
 * because the original column is not in this table.
 */
export const weeklyReportPhotos = pgTable(
  "weekly_report_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weeklyReportId: uuid("weekly_report_id")
      .notNull()
      .references(() => weeklyReports.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    caption: text("caption"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("weekly_report_photos_report_file_key").on(table.weeklyReportId, table.fileId),
    index("weekly_report_photos_report_idx").on(table.weeklyReportId, table.sortOrder),
  ],
);

/**
 * A week that was never filed and has been consciously written off.
 *
 * Keyed by (project, week_of) because a missed week has NO weekly_reports row to hang a dismissal on —
 * nobody ever started one. The dashboard generates expected weeks from the cadence and left-joins both
 * this table and weekly_reports; a week matching neither is "Not started" and keeps aging.
 */
export const weeklyReportDismissals = pgTable(
  "weekly_report_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weeklyReportProjectId: uuid("weekly_report_project_id")
      .notNull()
      .references(() => weeklyReportProjects.id, { onDelete: "cascade" }),
    weekOf: date("week_of").notNull(),
    reason: text("reason").notNull(),
    dismissedBy: uuid("dismissed_by"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("weekly_report_dismissals_project_week_key").on(
      table.weeklyReportProjectId,
      table.weekOf,
    ),
  ],
);

/**
 * The stretches a project was NOT reporting for. Migration 0223.
 *
 * `status` says only where the setup stands today, so it cannot answer "was this project reporting in
 * the week of the 6th?" — and the dashboard regenerates its expected weeks from the cadence start on
 * every read. Without this ledger a project paused for six weeks came back owing all six. The weeks
 * missed BEFORE the pause are deliberately left alone: they were, and remain, missed.
 *
 * `resumed_on` NULL means still stopped; the partial unique index (0223) permits exactly one such row
 * per project.
 */
export const weeklyReportPauses = pgTable(
  "weekly_report_pauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weeklyReportProjectId: uuid("weekly_report_project_id")
      .notNull()
      .references(() => weeklyReportProjects.id, { onDelete: "cascade" }),
    pausedFrom: date("paused_from").notNull(),
    resumedOn: date("resumed_on"),
    /** BARE uuids — the FK targets `public.users`, outside this tenant schema. Same convention as the
     *  setup row's PM/superintendent columns. */
    pausedBy: uuid("paused_by"),
    resumedBy: uuid("resumed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("weekly_report_pauses_project_idx").on(table.weeklyReportProjectId, table.pausedFrom),
    check(
      "weekly_report_pauses_range",
      sql`${table.resumedOn} IS NULL OR ${table.resumedOn} >= ${table.pausedFrom}`,
    ),
  ],
);

/**
 * Reminder idempotency ledger.
 *
 * The reminder cron is not idempotent without it: the worker restarts routinely (deploys, OOM, Railway
 * shuffles) and a restart inside the 07:00 window would re-send every reminder already sent that morning.
 */
export const weeklyReportRemindersSent = pgTable(
  "weekly_report_reminders_sent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weeklyReportProjectId: uuid("weekly_report_project_id")
      .notNull()
      .references(() => weeklyReportProjects.id, { onDelete: "cascade" }),
    weekOf: date("week_of").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("weekly_report_reminders_sent_key").on(
      table.weeklyReportProjectId,
      table.weekOf,
      table.kind,
    ),
  ],
);

/**
 * Per-office settings. Exactly one row, held by the `singleton` CHECK plus its UNIQUE constraint, so the
 * service can UPSERT without a prior SELECT and a concurrent double-save cannot create a second row.
 */
export const weeklyReportSettings = pgTable(
  "weekly_report_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singleton: boolean("singleton").default(true).notNull(),
    /** Who receives the due-day digest. A list rather than hardcoded names so the roster is a data change
     *  in the CRM, not a deploy. */
    leadershipRecipientEmails: text("leadership_recipient_emails").array().default([]).notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("weekly_report_settings_singleton_key").on(table.singleton),
    check("weekly_report_settings_singleton_check", sql`${table.singleton}`),
  ],
);
