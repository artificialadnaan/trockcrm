import {
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { deals } from "./deals.js";

/**
 * CRM-native change orders: additional signed work captured against a Won / Bid-Board-Owned
 * deal AFTER it closed. Distinct from the Procore-synced `change_orders` table (which mirrors
 * Procore contract change orders). These rows are CRM-only and are NEVER synced out to
 * Procore / Bid Board.
 *
 * Each row is its own DATED value record: its `amount` adds to the parent deal's Current
 * Contract Value, but for Won-value reporting it attributes to the period of its own
 * `signed_date` (NOT the parent deal's won_closed_date). Modeled as a dedicated table — never
 * a child deal — so change orders stay entirely out of deal counts / pipeline / rep-keyed
 * report invariants.
 */
export const dealChangeOrders = pgTable(
  "deal_change_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    // The date the change order was signed — the reporting period-attribution axis.
    signedDate: date("signed_date").notNull(),
    // Positive dollar amount (DB CHECK amount > 0 in migration 0152; also validated in the API).
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    description: text("description"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("deal_change_orders_deal_id_idx").on(table.dealId),
    index("deal_change_orders_signed_date_idx").on(table.signedDate),
  ]
);
