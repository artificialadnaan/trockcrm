import {
  pgTable,
  uuid,
  text,
  varchar,
  numeric,
  boolean,
  date,
  smallint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-office marketing & advertising expense requests (migration 0232) — the digitized paper form.
 *
 * REFERENCES, per the tenant-table convention: declared for the SAME-schema parent link on the approvals
 * table, omitted for the two cross-schema `public.users` columns (`submitted_by`, `decided_by`), which the
 * migration declares instead. The rule is "omit cross-schema", not "omit all" — 51 of the 87 files in this
 * directory declare same-schema references.
 *
 * MONEY. Every cost column is `numeric(14,2)` DOLLARS-with-cents, not cents, and Drizzle round-trips
 * numeric as a STRING. `totalRequested` is computed in SQL inside the write (see
 * server/src/modules/marketing-expense/service.ts) and is never summed in JS: there is no decimal helper in
 * this repo and floats do not add money.
 */
export const marketingExpenseRequests = pgTable(
  "marketing_expense_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `MER-` + a zero-padded per-office counter, allocated at CREATE. Unique within the office schema. */
    requestNumber: text("request_number").notNull(),
    /**
     * draft -> pending -> approved | denied, or pending -> withdrawn.
     *
     * `draft` is not decorative: a request has to exist before the client can upload attachments against
     * it, and the approver must not be emailed before those attachments are there. POST creates the draft,
     * the client uploads, POST /:id/submit flips it to pending and enqueues the mail.
     */
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    /** public.users(id) — FK in the migration, not here (cross-schema). */
    submittedBy: uuid("submitted_by").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),

    // ── Request information ──
    requestedByName: text("requested_by_name").notNull(),
    department: text("department"),
    neededBy: date("needed_by"),
    vendorEvent: text("vendor_event").notNull(),
    locationDates: text("location_dates"),

    // ── Narrative ──
    purpose: text("purpose").notNull(),
    expectedReturn: text("expected_return").notNull(),

    // ── Estimated cost ──
    costAdvertising: numeric("cost_advertising", { precision: 14, scale: 2 }).notNull().default("0"),
    costRegistration: numeric("cost_registration", { precision: 14, scale: 2 }).notNull().default("0"),
    costTravel: numeric("cost_travel", { precision: 14, scale: 2 }).notNull().default("0"),
    costLodging: numeric("cost_lodging", { precision: 14, scale: 2 }).notNull().default("0"),
    costMeals: numeric("cost_meals", { precision: 14, scale: 2 }).notNull().default("0"),
    costMaterials: numeric("cost_materials", { precision: 14, scale: 2 }).notNull().default("0"),
    costOther1: numeric("cost_other_1", { precision: 14, scale: 2 }).notNull().default("0"),
    costOther1Label: text("cost_other_1_label"),
    costOther2: numeric("cost_other_2", { precision: 14, scale: 2 }).notNull().default("0"),
    costOther2Label: text("cost_other_2_label"),
    /** Server-computed in SQL from the eight cost columns. A client-supplied total is ignored. */
    totalRequested: numeric("total_requested", { precision: 14, scale: 2 }).notNull(),
    budgetJobCode: text("budget_job_code"),

    // ── Travel / attendance ──
    travelRequired: boolean("travel_required").notNull().default(false),
    attendees: text("attendees"),
    businessMeetings: text("business_meetings"),

    // ── Payment & supporting information ──
    paymentMethod: varchar("payment_method", { length: 20 }),
    attachmentKinds: text("attachment_kinds").array().notNull().default([]),

    /**
     * How many approval steps must be `approved` before the parent is. Without this on the PARENT, "all
     * steps approved" is trivially true at one step and a second stage added later would still finalize
     * every existing request at step 1 — the reason "one approver now, two-stage ready" needed a column
     * and not just a table.
     */
    stepsRequired: smallint("steps_required").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("marketing_expense_requests_number_uq").on(table.requestNumber),
    // The two read paths: "my requests" (submitter, newest first) and the approver queue (status,
    // newest first).
    index("marketing_expense_requests_submitter_idx").on(table.submittedBy, table.createdAt.desc()),
    index("marketing_expense_requests_status_idx").on(table.status, table.createdAt.desc()),
  ],
);

/**
 * One row per configured approval STEP, all seeded at submit time. A CEO/CFO stage is step 2.
 *
 * `decision IS NULL` means exactly "still actionable" — which is only true because a denial or a
 * withdrawal writes `skipped` to every later step. Without that, a denied step-1 request would leave step 2
 * open in the queue forever.
 */
export const marketingExpenseRequestApprovals = pgTable(
  "marketing_expense_request_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => marketingExpenseRequests.id, { onDelete: "cascade" }),
    stepOrder: smallint("step_order").notNull(),
    approverGroupKey: text("approver_group_key").notNull(),
    /** null = undecided; 'approved' | 'denied' | 'skipped'. */
    decision: varchar("decision", { length: 20 }),
    /** public.users(id) — FK in the migration, not here (cross-schema). */
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("marketing_expense_approvals_request_step_uq").on(table.requestId, table.stepOrder),
    index("marketing_expense_approvals_open_idx").on(table.stepOrder, table.requestId),
  ],
);
