import { pgTable, uuid, varchar, integer, boolean } from "drizzle-orm/pg-core";

export const projectTypeConfig = pgTable("project_type_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  parentId: uuid("parent_id").references((): any => projectTypeConfig.id),
  displayOrder: integer("display_order").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});
