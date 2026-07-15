import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  numeric,
  bigint,
  integer,
  jsonb,
  date,
  timestamp,
  interval,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { DEAL_PIPELINE_DISPOSITIONS, WORKFLOW_ROUTES } from "../../types/enums.js";
import { SALES_WORKFLOW_PIPELINE_TYPES } from "../../types/sales-workflow.js";
import { companies } from "./companies.js";
import { contacts } from "./contacts.js";
import {
  forecastCategoryEnum as dealForecastCategoryEnum,
  forecastWindowEnum as dealForecastWindowEnum,
  leads,
  supportNeededTypeEnum as dealSupportNeededTypeEnum,
} from "./leads.js";
import { properties } from "./properties.js";

export const proposalStatusEnum = pgEnum("proposal_status", [
  "not_started",
  "drafting",
  "sent",
  "under_review",
  "revision_requested",
  "accepted",
  "signed",
  "rejected",
]);

export const estimatingSubstageEnum = pgEnum("estimating_substage", [
  "scope_review",
  "site_visit",
  "missing_info",
  "building_estimate",
  "under_review",
  "sent_to_client",
]);

// Note: These reference public schema tables by UUID. Drizzle cross-schema references
// are defined here for TypeScript typing. The actual FK constraints are in the SQL migration
// because Drizzle doesn't natively handle cross-schema references.

export const workflowRouteEnum = pgEnum("workflow_route", WORKFLOW_ROUTES);
export const dealPipelineTypeSnapshotEnum = pgEnum(
  "deal_pipeline_type_snapshot",
  SALES_WORKFLOW_PIPELINE_TYPES
);
export const dealPipelineDispositionEnum = pgEnum(
  "deal_pipeline_disposition",
  DEAL_PIPELINE_DISPOSITIONS
);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealNumber: varchar("deal_number", { length: 50 }).unique().notNull(),
    name: varchar("name", { length: 500 }).notNull(),
    stageId: uuid("stage_id").notNull(),
    assignedRepId: uuid("assigned_rep_id"),
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id),
    // Who gets billed for this project. The forward-only Won attention queue lives in app logic, not a DB
    // constraint, so existing/in-flight deals remain unaffected.
    billingContactId: uuid("billing_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    // Forward-only billing-attention marker. Existing deals intentionally remain NULL; normal projects
    // created after this feature ships are stamped by createDeal.
    billingContactRequiredAt: timestamp("billing_contact_required_at", { withTimezone: true }),
    companyId: uuid("company_id").references(() => companies.id),
    propertyId: uuid("property_id").references(() => properties.id),
    sourceLeadId: uuid("source_lead_id").references(() => leads.id).unique(),
    ddEstimate: numeric("dd_estimate", { precision: 14, scale: 2 }),
    bidEstimate: numeric("bid_estimate", { precision: 14, scale: 2 }),
    awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
    // Set only by a genuine admin/director manual edit of awarded_amount (createDeal/updateDeal user
    // input) — NOT by the #688 won-transition seed. When true the Procore mirror never overwrites
    // awarded_amount (see buildBidBoardMirrorUpdate). Migration 0159.
    awardedAmountOverridden: boolean("awarded_amount_overridden").notNull().default(false),
    // Set only by a genuine manual edit of dd_estimate (createDeal/updateDeal user input). When true the
    // Procore mirror never overwrites dd_estimate (see buildBidBoardMirrorUpdate). DD is editable on every
    // deal incl. bid-board-owned; unlike awarded_amount it is NOT role-gated. Migration 0164.
    ddEstimateOverridden: boolean("dd_estimate_overridden").notNull().default(false),
    changeOrderTotal: numeric("change_order_total", { precision: 14, scale: 2 }).default("0"),
    description: text("description"),
    estimator: text("estimator"),
    propertyAddress: text("property_address"),
    propertyCity: varchar("property_city", { length: 255 }),
    propertyState: varchar("property_state", { length: 2 }),
    propertyZip: varchar("property_zip", { length: 10 }),
    propertyCountry: text("property_country"),
    officeCode: text("office_code"),
    projectType: text("project_type"),
    projectTypeId: uuid("project_type_id"),
    regionId: uuid("region_id"),
    source: varchar("source", { length: 100 }),
    winProbability: integer("win_probability"),
    decisionMakerName: varchar("decision_maker_name", { length: 255 }),
    decisionProcess: text("decision_process"),
    budgetStatus: varchar("budget_status", { length: 100 }),
    incumbentVendor: varchar("incumbent_vendor", { length: 255 }),
    unitCount: integer("unit_count"),
    buildYear: integer("build_year"),
    forecastWindow: dealForecastWindowEnum("forecast_window"),
    forecastCategory: dealForecastCategoryEnum("forecast_category"),
    forecastConfidencePercent: integer("forecast_confidence_percent"),
    forecastRevenue: numeric("forecast_revenue", { precision: 14, scale: 2 }),
    forecastGrossProfit: numeric("forecast_gross_profit", { precision: 14, scale: 2 }),
    forecastBlockers: text("forecast_blockers"),
    nextStep: text("next_step"),
    nextStepDueAt: timestamp("next_step_due_at", { withTimezone: true }),
    nextMilestoneAt: timestamp("next_milestone_at", { withTimezone: true }),
    supportNeededType: dealSupportNeededTypeEnum("support_needed_type"),
    supportNeededNotes: text("support_needed_notes"),
    forecastUpdatedAt: timestamp("forecast_updated_at", { withTimezone: true }),
    forecastUpdatedBy: uuid("forecast_updated_by"),
    emailCount: integer("email_count").default(0).notNull(),
    lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
    procoreProjectId: bigint("procore_project_id", { mode: "number" }),
    procoreCompanyId: text("procore_company_id"),
    procoreBidId: bigint("procore_bid_id", { mode: "number" }),
    // Stable SyncHub-side identity. Unlike a project name, this remains safe when distinct
    // projects at the same property share a display name.
    synchubBidBoardId: text("synchub_bid_board_id"),
    procoreImageCategoryId: bigint("procore_image_category_id", { mode: "number" }),
    procorePhotoLinkId: bigint("procore_photo_link_id", { mode: "number" }),
    procorePhotoLinkStatus: varchar("procore_photo_link_status", { length: 50 }),
    procoreLastSyncedAt: timestamp("procore_last_synced_at", { withTimezone: true }),
    isBidBoardOwned: boolean("is_bid_board_owned").default(false).notNull(),
    bidBoardStageSlug: varchar("bid_board_stage_slug", { length: 100 }),
    bidBoardStageFamily: varchar("bid_board_stage_family", { length: 50 }),
    bidBoardStageStatus: varchar("bid_board_stage_status", { length: 50 }),
    bidBoardStageEnteredAt: timestamp("bid_board_stage_entered_at", { withTimezone: true }),
    bidBoardStageExitedAt: timestamp("bid_board_stage_exited_at", { withTimezone: true }),
    bidBoardStageDuration: interval("bid_board_stage_duration"),
    bidBoardLossOutcome: varchar("bid_board_loss_outcome", { length: 100 }),
    bidBoardEstimator: text("bid_board_estimator"),
    // Resolved at ingest from bid_board_estimator via BID_BOARD_ESTIMATOR_USER_MAP, so the
    // rep/owner filter can match deals a person ESTIMATED (not just ones they own as rep).
    estimatorUserId: uuid("estimator_user_id"),
    // The capX rep who SOURCED a service opportunity (set once at creation, locked after; admin/
    // director override). Drives the additive attribution_role='sales_source' commission + floor leg.
    salesSourceUserId: uuid("sales_source_user_id"),
    bidBoardOffice: text("bid_board_office"),
    bidBoardStatus: text("bid_board_status"),
    bidBoardSalesPricePerArea: text("bid_board_sales_price_per_area"),
    bidBoardProjectCost: numeric("bid_board_project_cost", { precision: 14, scale: 2 }),
    bidBoardProfitMarginPct: numeric("bid_board_profit_margin_pct", { precision: 9, scale: 4 }),
    bidBoardTotalSales: numeric("bid_board_total_sales", { precision: 14, scale: 2 }),
    bidBoardCreatedAt: timestamp("bid_board_created_at", { withTimezone: true }),
    bidBoardDueDate: date("bid_board_due_date"),
    bidBoardCustomerName: text("bid_board_customer_name"),
    bidBoardCustomerContactRaw: text("bid_board_customer_contact_raw"),
    bidBoardProjectNumber: text("bid_board_project_number"),
    projectNumber: text("project_number"),
    bidBoardLinkedAt: timestamp("bid_board_linked_at", { withTimezone: true }),
    bidBoardLastUpdatedAt: timestamp("bid_board_last_updated_at", { withTimezone: true }),
    // Assigned PM is not present in the Bid Board export; role polling can populate this after portfolio handoff.
    bidBoardAssignedPm: text("bid_board_assigned_pm"),
    intendedProjectNumber: text("intended_project_number"),
    bidBoardMirrorSourceEnteredAt: timestamp("bid_board_mirror_source_entered_at", {
      withTimezone: true,
    }),
    bidBoardMirrorSourceExitedAt: timestamp("bid_board_mirror_source_exited_at", {
      withTimezone: true,
    }),
    pipelineTypeSnapshot: dealPipelineTypeSnapshotEnum("pipeline_type_snapshot")
      .default("normal")
      .notNull(),
    regionClassification: varchar("region_classification", { length: 50 }),
    isReadOnlyMirror: boolean("is_read_only_mirror").default(false).notNull(),
    isReadOnlySyncDirty: boolean("is_read_only_sync_dirty").default(false).notNull(),
    readOnlySyncedAt: timestamp("read_only_synced_at", { withTimezone: true }),
    hubspotOwnerId: varchar("hubspot_owner_id", { length: 64 }),
    hubspotOwnerEmail: varchar("hubspot_owner_email", { length: 320 }),
    ownershipSyncedAt: timestamp("ownership_synced_at", { withTimezone: true }),
    ownershipSyncStatus: varchar("ownership_sync_status", { length: 32 }),
    unassignedReasonCode: varchar("unassigned_reason_code", { length: 64 }),
    lostReasonId: uuid("lost_reason_id"),
    lostNotes: text("lost_notes"),
    lostCompetitor: varchar("lost_competitor", { length: 255 }),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    expectedCloseDate: date("expected_close_date"),
    actualCloseDate: date("actual_close_date"),
    // App-owned Won-period reporting date (migration 0141). Set ONLY by
    // changeDealStage on Won-outcome entry; cleared on reopen / Lost. The reporting
    // helpers gate Won YTD/MTD windows on this column once flipped -- decoupled from
    // the HubSpot JSON blob and contamination-free vs actual_close_date. See
    // .reviews/trockcrm-date-field-decision/plan.md.
    wonClosedDate: date("won_closed_date"),
    contractSignedDate: date("contract_signed_date"),
    contractSignedAt: timestamp("contract_signed_at", { withTimezone: true }),
    rfpApprovalRequestedAt: timestamp("rfp_approval_requested_at", { withTimezone: true }),
    rfpApprovalRequestEventId: uuid("rfp_approval_request_event_id"),
    rfpApprovalRequestedBy: uuid("rfp_approval_requested_by"),
    rfpApprovalRequestId: integer("rfp_approval_request_id"),
    rfpApprovalToken: text("rfp_approval_token"),
    rfpApprovalStatus: text("rfp_approval_status"),
    rfpDeclinedReason: text("rfp_declined_reason"),
    rfpDeclinedAt: timestamp("rfp_declined_at", { withTimezone: true }),
    // Second-look override-review state (migration 0151). Set when Takashi/Adam review a declined RFP:
    // approving re-submits it (and clears these back to NULL for the fresh cycle); re-confirming records
    // 'denial_reconfirmed' so the decline is not perpetually re-flagged. See rfp-override-service.ts.
    rfpOverrideReviewedAt: timestamp("rfp_override_reviewed_at", { withTimezone: true }),
    rfpOverrideReviewedBy: uuid("rfp_override_reviewed_by"),
    rfpOverrideDecision: text("rfp_override_decision"),
    rfpOverrideNote: text("rfp_override_note"),
    // Override-approval delivery state (migration 0152): NULL | 'approving' (SyncHub Playwright creating the
    // Bid Board project) | 'failed' (creation failed, retryable). See rfp-override-service.ts.
    rfpOverrideState: text("rfp_override_state"),
    rfpOverrideError: text("rfp_override_error"),
    // Per-attempt marker for a request-less (voting-path) Bid Board create (migration 0177). Stamped by each
    // /rfp-retry so a late duplicate 'failed' callback or dead rfp_bidboard_create job from a PRIOR attempt
    // can't flip a fresh in-flight retry back to send_failed. NULL for the first attempt (exempt) + cleared on
    // link/cancel. See internal-rfp bid-board-created failed path + runRfpBidBoardCreateDeadLetterSweep.
    rfpBidboardAttemptAt: timestamp("rfp_bidboard_attempt_at", { withTimezone: true }),
    rfpConflictReason: text("rfp_conflict_reason"),
    rfpConflictWith: jsonb("rfp_conflict_with"),
    rfpLastAttemptError: text("rfp_last_attempt_error"),
    lastSyncedFromHubspotAt: timestamp("last_synced_from_hubspot_at", { withTimezone: true }),
    workflowRoute: workflowRouteEnum("workflow_route").default("normal").notNull(),
    pipelineDisposition: dealPipelineDispositionEnum("pipeline_disposition")
      .default("deals")
      .notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    onHold: boolean("on_hold").default(false).notNull(),
    onHoldStartedAt: timestamp("on_hold_started_at", { withTimezone: true }),
    onHoldAccumulatedSeconds: bigint("on_hold_accumulated_seconds", { mode: "number" })
      .default(0)
      .notNull(),
    onHoldAccumulatedSecondsAtStageEntry: bigint("on_hold_accumulated_seconds_at_stage_entry", {
      mode: "number",
    })
      .default(0)
      .notNull(),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).defaultNow().notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    hubspotDealId: varchar("hubspot_deal_id", { length: 50 }),
    /**
     * @deprecated Single-project link. Superseded by the `dealCompanycamProjects` join table (a deal can
     * own many CompanyCam projects). No longer read or written as of migration 0171; kept to avoid a
     * data-losing column drop in the same PR and dropped in a later migration.
     */
    companycamProjectId: varchar("companycam_project_id", { length: 50 }),
    createdByUserId: uuid("created_by_user_id"),
    propertyLat: numeric("property_lat", { precision: 10, scale: 7 }),
    propertyLng: numeric("property_lng", { precision: 10, scale: 7 }),
    estimatingSubstage: estimatingSubstageEnum("estimating_substage"),
    proposalStatus: proposalStatusEnum("proposal_status").default("not_started"),
    proposalDraftStartedAt: timestamp("proposal_draft_started_at", { withTimezone: true }),
    proposalSentAt: timestamp("proposal_sent_at", { withTimezone: true }),
    proposalAcceptedAt: timestamp("proposal_accepted_at", { withTimezone: true }),
    bidDueDate: timestamp("bid_due_date", { withTimezone: true }),
    proposalRevisionCount: integer("proposal_revision_count").default(0),
    proposalNotes: text("proposal_notes"),
    isTestData: boolean("is_test_data").default(false).notNull(),
    // Change Orders model (PR1): a change order is a real CHILD deal — value=CO amount, stage=Won,
    // won_closed_date=CO date, parent_deal_id set, is_change_order=true. It SHARES the parent's
    // project_number (the partial-unique index below exempts is_change_order rows) and is CRM-only
    // (the Bid Board sync skips is_change_order deals). parent_deal_id FK is in the SQL migration
    // (self-reference, like the other cross-schema FKs handled there).
    isChangeOrder: boolean("is_change_order").default(false).notNull(),
    parentDealId: uuid("parent_deal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Project number is unique among NON-change-order deals only. CO children intentionally share the
    // parent's project_number, so they are exempted here (and from the live DB index in the migration).
    uniqueIndex("deals_project_number_uidx")
      .on(table.projectNumber)
      .where(sql`${table.projectNumber} IS NOT NULL AND ${table.isChangeOrder} = false`),
    // Partial index backing the company-directory aggregate fold (Properties/Contacts/Active-deals/
    // Pipeline$ sort) — the deals GROUP-BY-company_id over active deals + the hasActivePipeline drill.
    // Source of truth for migration 0167 (deals_company_active_idx); applied per-office there.
    index("deals_company_active_idx")
      .on(table.companyId)
      .where(sql`${table.isActive} = true`),
    // Partial index backing the Properties Linked Value fold (listProperties' active-deal aggregate
    // grouped by property_id). Source-of-truth mirror of migration 0168_deals_property_active_idx.sql.
    index("deals_property_active_idx")
      .on(table.propertyId)
      .where(sql`${table.isActive} = TRUE`),
  ]
);
