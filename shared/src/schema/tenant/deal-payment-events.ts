import {
  pgTable,
  uuid,
  numeric,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { deals } from "./deals.js";

export const dealPaymentEvents = pgTable(
  "deal_payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    grossRevenueAmount: numeric("gross_revenue_amount", { precision: 14, scale: 2 }).notNull(),
    grossMarginAmount: numeric("gross_margin_amount", { precision: 14, scale: 2 }),
    isCreditMemo: boolean("is_credit_memo").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("deal_payment_events_deal_paid_at_idx").on(table.dealId, table.paidAt),
    index("deal_payment_events_paid_at_idx").on(table.paidAt),
  ]
);
