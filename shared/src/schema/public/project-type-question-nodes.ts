import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { projectTypeConfig } from "./project-type-config.js";

export const projectTypeQuestionNodes = pgTable(
  "project_type_question_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectTypeId: uuid("project_type_id").references(() => projectTypeConfig.id),
    parentNodeId: uuid("parent_node_id").references((): any => projectTypeQuestionNodes.id),
    parentOptionValue: varchar("parent_option_value", { length: 255 }),
    nodeType: varchar("node_type", { length: 50 }).default("question").notNull(),
    key: varchar("key", { length: 120 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    prompt: text("prompt"),
    inputType: varchar("input_type", { length: 50 }),
    options: jsonb("options").default([]).notNull(),
    isRequired: boolean("is_required").default(false).notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("project_type_question_nodes_project_type_idx").on(table.projectTypeId, table.displayOrder),
    index("project_type_question_nodes_parent_idx").on(table.parentNodeId, table.displayOrder),
    index("project_type_question_nodes_active_idx").on(table.isActive, table.displayOrder),
  ]
);
