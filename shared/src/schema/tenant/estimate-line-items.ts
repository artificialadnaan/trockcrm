import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const estimateLineItems = pgTable("estimate_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  sectionId: uuid("section_id").notNull(),
  description: varchar("description", { length: 500 }).notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).default("1").notNull(),
  unit: varchar("unit", { length: 50 }),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).default("0").notNull(),
  totalPrice: numeric("total_price", { precision: 14, scale: 2 }).default("0").notNull(),
  notes: text("notes"),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
