import { index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { emails } from "./emails.js";

export const emailLinks = pgTable(
  "email_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id").notNull().references(() => emails.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    unique().on(table.emailId, table.entityType, table.entityId),
    index("email_links_email_idx").on(table.emailId),
    index("email_links_entity_idx").on(table.entityType, table.entityId),
  ]
);
