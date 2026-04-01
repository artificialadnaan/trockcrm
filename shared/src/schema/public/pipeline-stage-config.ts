import { pgTable, uuid, varchar, integer, boolean, jsonb } from "drizzle-orm/pg-core";

export const pipelineStageConfig = pgTable("pipeline_stage_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  displayOrder: integer("display_order").notNull(),
  isActivePipeline: boolean("is_active_pipeline").default(true).notNull(),
  isTerminal: boolean("is_terminal").default(false).notNull(),
  requiredFields: jsonb("required_fields").default([]).notNull(),
  requiredDocuments: jsonb("required_documents").default([]).notNull(),
  requiredApprovals: jsonb("required_approvals").default([]).notNull(),
  staleThresholdDays: integer("stale_threshold_days"),
  procoreStageMapping: varchar("procore_stage_mapping", { length: 100 }),
  color: varchar("color", { length: 7 }),
});
