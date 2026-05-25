import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { offices } from "./offices.js";

export const portfolioProjectStageEventReceipts = pgTable(
  "portfolio_project_stage_event_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventKey: text("event_key").notNull(),
    status: text("status").notNull(),
    officeId: uuid("office_id").references(() => offices.id, { onDelete: "set null" }),
    officeSlug: text("office_slug"),
    procoreCompanyId: text("procore_company_id").notNull(),
    procorePortfolioProjectId: text("procore_portfolio_project_id").notNull(),
    projectNumber: text("project_number"),
    projectName: text("project_name"),
    previousStage: text("previous_stage"),
    currentStage: text("current_stage").notNull(),
    currentStageNormalized: text("current_stage_normalized").notNull(),
    isBoardRelevant: boolean("is_board_relevant").default(false).notNull(),
    syncHubWebhookLogId: text("synchub_webhook_log_id"),
    syncHubSyncMappingId: text("synchub_sync_mapping_id"),
    errorReason: text("error_reason"),
    rawPayload: jsonb("raw_payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("portfolio_project_stage_event_receipts_event_key_uidx").on(table.eventKey),
    index("portfolio_project_stage_event_receipts_project_idx").on(table.procorePortfolioProjectId),
    index("portfolio_project_stage_event_receipts_status_idx").on(table.status, table.receivedAt),
  ]
);
