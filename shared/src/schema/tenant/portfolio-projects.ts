import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const portfolioProjects = pgTable(
  "portfolio_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procoreCompanyId: text("procore_company_id").notNull(),
    procoreProjectId: text("procore_project_id").notNull(),
    projectNumber: text("project_number"),
    name: text("name").notNull(),
    currentStage: text("current_stage").notNull(),
    currentStageNormalized: text("current_stage_normalized").notNull(),
    currentStageEnteredAt: timestamp("current_stage_entered_at", { withTimezone: true }),
    isBoardRelevant: boolean("is_board_relevant").default(false).notNull(),
    totalValue: numeric("total_value", { precision: 14, scale: 2 }),
    valueSyncedAt: timestamp("value_synced_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastStageEventKey: text("last_stage_event_key"),
    rawSnapshot: jsonb("raw_snapshot").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("portfolio_projects_company_project_uidx").on(table.procoreCompanyId, table.procoreProjectId),
    index("portfolio_projects_stage_idx").on(table.currentStageNormalized, table.isBoardRelevant),
    index("portfolio_projects_project_number_idx").on(table.projectNumber),
  ]
);

export const portfolioProjectStageEntries = pgTable(
  "portfolio_project_stage_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioProjectId: uuid("portfolio_project_id").notNull().references(() => portfolioProjects.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    previousStage: text("previous_stage"),
    previousStageNormalized: text("previous_stage_normalized"),
    stage: text("stage").notNull(),
    stageNormalized: text("stage_normalized").notNull(),
    isBoardRelevant: boolean("is_board_relevant").default(false).notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    relayDetectedAt: timestamp("relay_detected_at", { withTimezone: true }),
    webhookTimestamp: timestamp("webhook_timestamp", { withTimezone: true }),
    rawEvent: jsonb("raw_event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("portfolio_project_stage_entries_event_key_key").on(table.eventKey),
    index("portfolio_project_stage_entries_project_idx").on(table.portfolioProjectId, table.enteredAt),
  ]
);
