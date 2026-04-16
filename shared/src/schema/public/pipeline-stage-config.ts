import { pgEnum, pgTable, uuid, varchar, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { WORKFLOW_FAMILIES } from "../../types/enums.js";

export const workflowFamilyEnum = pgEnum("workflow_family", WORKFLOW_FAMILIES);

export const pipelineStageConfig = pgTable("pipeline_stage_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  displayOrder: integer("display_order").notNull(),
  workflowFamily: workflowFamilyEnum("workflow_family").default("standard_deal").notNull(),
  isActivePipeline: boolean("is_active_pipeline").default(true).notNull(),
  isTerminal: boolean("is_terminal").default(false).notNull(),
  requiredFields: jsonb("required_fields").default([]).notNull(),
  requiredDocuments: jsonb("required_documents").default([]).notNull(),
  requiredApprovals: jsonb("required_approvals").default([]).notNull(),
  staleThresholdDays: integer("stale_threshold_days"),
  touchpointCadenceDays: integer("touchpoint_cadence_days").default(14),
  staleEscalationTiers: jsonb("stale_escalation_tiers").default([
    { days: 30, severity: "warning" },
    { days: 60, severity: "escalation" },
    { days: 90, severity: "critical" },
  ]),
  procoreStageMapping: varchar("procore_stage_mapping", { length: 100 }),
  color: varchar("color", { length: 7 }),
});
