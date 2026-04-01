import {
  pgTable,
  bigserial,
  varchar,
  bigint,
  jsonb,
  boolean,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const procoreWebhookLog = pgTable(
  "procore_webhook_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    resourceId: bigint("resource_id", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    processed: boolean("processed").default(false).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("webhook_unprocessed_idx").on(table.processed, table.receivedAt)]
);
