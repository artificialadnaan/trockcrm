import {
  pgTable,
  uuid,
  numeric,
  date,
  timestamp,
  text,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { deals } from "./deals.js";

export const dealSignedCommissions = pgTable(
  "deal_signed_commissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    repUserId: uuid("rep_user_id").notNull(),
    sourceValueKind: text("source_value_kind").notNull(),
    sourceValueAmount: numeric("source_value_amount", { precision: 14, scale: 2 }).notNull(),
    appliedRate: numeric("applied_rate", { precision: 7, scale: 6 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    contractSignedDateAtSigning: date("contract_signed_date_at_signing").notNull(),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("deal_signed_commissions_dedup").on(table.dealId, table.repUserId),
    index("deal_signed_commissions_rep_calc_idx").on(table.repUserId, table.calculatedAt),
    index("deal_signed_commissions_deal_idx").on(table.dealId),
  ]
);
