import {
  pgTable,
  pgEnum,
  uuid,
  integer,
  varchar,
  numeric,
  bigint,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { CHANGE_ORDER_STATUSES } from "../../types/enums.js";

export const changeOrderStatusEnum = pgEnum("change_order_status", CHANGE_ORDER_STATUSES);

export const changeOrders = pgTable(
  "change_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    coNumber: integer("co_number").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    status: changeOrderStatusEnum("status").default("pending").notNull(),
    procoreCoId: bigint("procore_co_id", { mode: "number" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.dealId, table.coNumber)]
);
