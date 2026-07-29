import {
  pgTable,
  uuid,
  numeric,
  date,
  timestamp,
  text,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { deals } from "./deals.js";

export const dealSignedCommissions = pgTable(
  "deal_signed_commissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    repUserId: uuid("rep_user_id").notNull(),
    // Distinguishes the deal OWNER's full-cut row from an ESTIMATOR's additive row. Load-bearing for the
    // estimator-removal path: after an owner reassignment rep_user_id alone can no longer tell the two
    // apart, so the estimator delete scopes to attribution_role = 'estimator' to never wipe an owner row.
    // NOT part of the (deal_id, rep_user_id) unique key. Backfilled to 'owner' (migration 0162).
    attributionRole: text("attribution_role").notNull().default("owner"),
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
    // The DB CHECKs from migration 0062, minus the two migration 0202 drops. Modelled here so fixtures
    // derived from this table (server/tests/helpers/tenant-schema-from-drizzle.ts) reject exactly the rows
    // prod rejects — the omission is what let the deductive change order's claw-back pass every test and
    // then raise 23514 in prod.
    //
    // amount and source_value_amount are DELIBERATELY UNBOUNDED IN SIGN (0202): a deductive change order
    // mints a NEGATIVE owner row so a rep's earned commission tracks the CURRENT contract value. Do not
    // reintroduce a `>= 0` CHECK on either — it cannot be scoped to non-change-order rows (a CHECK cannot
    // join, and this table has no is_change_order column) and it aborts the enclosing signing transaction.
    check(
      "deal_signed_commissions_rate_bounds_chk",
      sql`${table.appliedRate} >= 0 AND ${table.appliedRate} <= 1`
    ),
    check(
      "deal_signed_commissions_source_value_kind_chk",
      sql`${table.sourceValueKind} IN ('awarded_amount', 'bid_estimate', 'dd_estimate')`
    ),
  ]
);
