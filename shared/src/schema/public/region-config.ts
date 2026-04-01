import { pgTable, uuid, varchar, integer, boolean, text } from "drizzle-orm/pg-core";

export const regionConfig = pgTable("region_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  states: text("states").array().notNull(),
  displayOrder: integer("display_order").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});
