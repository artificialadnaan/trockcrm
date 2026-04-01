import { pgTable, uuid, varchar, boolean, integer } from "drizzle-orm/pg-core";

export const lostDealReasons = pgTable("lost_deal_reasons", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: varchar("label", { length: 255 }).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  displayOrder: integer("display_order").notNull(),
});
