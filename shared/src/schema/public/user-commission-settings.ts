import {
  pgTable,
  uuid,
  numeric,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userCommissionSettings = pgTable("user_commission_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  commissionRate: numeric("commission_rate", { precision: 7, scale: 6 }).notNull().default("0"),
  rollingFloor: numeric("rolling_floor", { precision: 14, scale: 2 }).notNull().default("0"),
  overrideRate: numeric("override_rate", { precision: 7, scale: 6 }).notNull().default("0"),
  estimatedMarginRate: numeric("estimated_margin_rate", { precision: 7, scale: 6 }).notNull().default("0.30"),
  minMarginPercent: numeric("min_margin_percent", { precision: 7, scale: 6 }).notNull().default("0.20"),
  newCustomerShareFloor: numeric("new_customer_share_floor", { precision: 7, scale: 6 }).notNull().default("0.10"),
  newCustomerWindowMonths: integer("new_customer_window_months").notNull().default(6),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
