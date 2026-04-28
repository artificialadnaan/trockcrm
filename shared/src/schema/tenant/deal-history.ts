import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

import { deals } from "./deals.js";
import { users } from "../public/users.js";

export const dealHistory = pgTable("deal_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").references(() => deals.id).notNull(),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedBy: uuid("changed_by").references(() => users.id).notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
});
