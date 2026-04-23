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
  date,
  timestamp,
  interval,
} from "drizzle-orm/pg-core";
import { WORKFLOW_ROUTES } from "../../types/enums.js";
import { SALES_WORKFLOW_PIPELINE_TYPES } from "../../types/sales-workflow.js";
import { companies } from "./companies.js";
import { contacts } from "./contacts.js";
import { leads } from "./leads.js";
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

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealNumber: varchar("deal_number", { length: 50 }).unique().notNull(),
  name: varchar("name", { length: 500 }).notNull(),
  stageId: uuid("stage_id").notNull(),
  assignedRepId: uuid("assigned_rep_id").notNull(),
  primaryContactId: uuid("primary_contact_id").references(() => contacts.id),
  companyId: uuid("company_id").references(() => companies.id),
  propertyId: uuid("property_id").references(() => properties.id),
  sourceLeadId: uuid("source_lead_id").references(() => leads.id).unique(),
  ddEstimate: numeric("dd_estimate", { precision: 14, scale: 2 }),
  bidEstimate: numeric("bid_estimate", { precision: 14, scale: 2 }),
  awardedAmount: numeric("awarded_amount", { precision: 14, scale: 2 }),
  changeOrderTotal: numeric("change_order_total", { precision: 14, scale: 2 }).default("0"),
  description: text("description"),
  propertyAddress: text("property_address"),
  propertyCity: varchar("property_city", { length: 255 }),
  propertyState: varchar("property_state", { length: 2 }),
  propertyZip: varchar("property_zip", { length: 10 }),
  projectTypeId: uuid("project_type_id"),
  regionId: uuid("region_id"),
  source: varchar("source", { length: 100 }),
  winProbability: integer("win_probability"),
  procoreProjectId: bigint("procore_project_id", { mode: "number" }),
  procoreBidId: bigint("procore_bid_id", { mode: "number" }),
  procoreLastSyncedAt: timestamp("procore_last_synced_at", { withTimezone: true }),
  isBidBoardOwned: boolean("is_bid_board_owned").default(false).notNull(),
  bidBoardStageSlug: varchar("bid_board_stage_slug", { length: 100 }),
  bidBoardStageFamily: varchar("bid_board_stage_family", { length: 50 }),
  bidBoardStageStatus: varchar("bid_board_stage_status", { length: 50 }),
  bidBoardStageEnteredAt: timestamp("bid_board_stage_entered_at", { withTimezone: true }),
  bidBoardStageExitedAt: timestamp("bid_board_stage_exited_at", { withTimezone: true }),
  bidBoardStageDuration: interval("bid_board_stage_duration"),
  bidBoardLossOutcome: varchar("bid_board_loss_outcome", { length: 100 }),
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
  lostReasonId: uuid("lost_reason_id"),
  lostNotes: text("lost_notes"),
  lostCompetitor: varchar("lost_competitor", { length: 255 }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  expectedCloseDate: date("expected_close_date"),
  actualCloseDate: date("actual_close_date"),
  workflowRoute: workflowRouteEnum("workflow_route").default("normal").notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).defaultNow().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  hubspotDealId: varchar("hubspot_deal_id", { length: 50 }),
  companycamProjectId: varchar("companycam_project_id", { length: 50 }),
  propertyLat: numeric("property_lat", { precision: 10, scale: 7 }),
  propertyLng: numeric("property_lng", { precision: 10, scale: 7 }),
  estimatingSubstage: estimatingSubstageEnum("estimating_substage"),
  proposalStatus: proposalStatusEnum("proposal_status").default("not_started"),
  proposalSentAt: timestamp("proposal_sent_at", { withTimezone: true }),
  proposalAcceptedAt: timestamp("proposal_accepted_at", { withTimezone: true }),
  proposalRevisionCount: integer("proposal_revision_count").default(0),
  proposalNotes: text("proposal_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
