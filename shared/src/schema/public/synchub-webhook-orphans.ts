import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { offices } from "./offices.js";
import { users } from "./users.js";

export const syncHubWebhookOrphans = pgTable(
  "synchub_webhook_orphans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => offices.id),
    syncHubWebhookLogId: text("synchub_webhook_log_id"),
    syncHubSyncMappingId: text("synchub_sync_mapping_id"),
    procoreCompanyId: text("procore_company_id").notNull(),
    procorePortfolioProjectId: text("procore_portfolio_project_id").notNull(),
    projectNumber: text("project_number"),
    projectName: text("project_name"),
    rawPayload: jsonb("raw_payload").notNull(),
    status: text("status").default("open").notNull(),
    notes: text("notes"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
  },
  (table) => [
    index("synchub_webhook_orphans_status_idx").on(table.status),
    index("synchub_webhook_orphans_received_at_idx").on(table.receivedAt),
    index("synchub_webhook_orphans_project_number_idx").on(table.projectNumber),
    index("synchub_webhook_orphans_portfolio_project_idx").on(table.procorePortfolioProjectId),
  ]
);
