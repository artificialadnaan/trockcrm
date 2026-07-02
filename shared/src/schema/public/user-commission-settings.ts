import {
  pgTable,
  uuid,
  numeric,
  integer,
  boolean,
  text,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

export const userCommissionSettings = pgTable(
  "user_commission_settings",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    commissionRate: numeric("commission_rate", { precision: 7, scale: 6 }).notNull().default("0"),
    commissionStructure: text("commission_structure").notNull().default("solo"),
    capxRateSolo: numeric("capx_rate_solo", { precision: 7, scale: 6 }).notNull().default("0"),
    capxRateMixed: numeric("capx_rate_mixed", { precision: 7, scale: 6 }).notNull().default("0"),
    serviceSourceRate: numeric("service_source_rate", { precision: 7, scale: 6 }).notNull().default("0"),
    rollingFloor: numeric("rolling_floor", { precision: 14, scale: 2 }).notNull().default("0"),
    overrideRate: numeric("override_rate", { precision: 7, scale: 6 }).notNull().default("0"),
    estimatedMarginRate: numeric("estimated_margin_rate", { precision: 7, scale: 6 }).notNull().default("0.30"),
    minMarginPercent: numeric("min_margin_percent", { precision: 7, scale: 6 }).notNull().default("0.20"),
    newCustomerShareFloor: numeric("new_customer_share_floor", { precision: 7, scale: 6 }).notNull().default("0.10"),
    newCustomerWindowMonths: integer("new_customer_window_months").notNull().default(6),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Mirrors the DB CHECK added in migration 0173: only 'solo' | 'mixed' can be persisted, so reads
    // that flow into resolveEffectiveCapxRate can never see an invalid structure. Complements the
    // write-path assertCommissionStructure guard.
    check("user_commission_settings_structure_check", sql`${table.commissionStructure} IN ('solo', 'mixed')`),
  ],
);
