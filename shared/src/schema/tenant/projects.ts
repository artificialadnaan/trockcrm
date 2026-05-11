import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { deals } from "./deals.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDealId: uuid("source_deal_id").references(() => deals.id),
    procoreProjectId: text("procore_project_id").notNull(),
    procoreCompanyId: text("procore_company_id").notNull(),
    procoreProjectNumber: text("procore_project_number"),
    name: text("name").notNull(),
    description: text("description"),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country"),
    currentPhaseId: text("current_phase_id"),
    currentPhaseName: text("current_phase_name"),
    currentPhaseSortOrder: integer("current_phase_sort_order"),
    isActive: boolean("is_active").default(true).notNull(),
    startDate: date("start_date"),
    completionDate: date("completion_date"),
    projectedFinishDate: date("projected_finish_date"),
    warrantyEndDate: date("warranty_end_date"),
    estimatedValue: numeric("estimated_value", { precision: 14, scale: 2 }),
    contractValue: numeric("contract_value", { precision: 14, scale: 2 }),
    actualCost: numeric("actual_cost", { precision: 14, scale: 2 }),
    projectOwnerId: text("project_owner_id"),
    projectOwnerName: text("project_owner_name"),
    procoreCreatedAt: timestamp("procore_created_at", { withTimezone: true }),
    procoreUpdatedAt: timestamp("procore_updated_at", { withTimezone: true }),
    procoreRawSnapshot: jsonb("procore_raw_snapshot").default({}).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
    syncSource: text("sync_source").default("manual").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("projects_procore_project_id_uidx").on(table.procoreProjectId),
    index("projects_source_deal_idx").on(table.sourceDealId),
    index("projects_project_number_idx").on(table.procoreProjectNumber),
    index("projects_phase_idx").on(table.currentPhaseId),
    index("projects_phase_name_idx").on(table.currentPhaseName),
  ]
);

export const projectPhaseHistory = pgTable(
  "project_phase_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    fromPhaseId: text("from_phase_id"),
    fromPhaseName: text("from_phase_name"),
    toPhaseId: text("to_phase_id"),
    toPhaseName: text("to_phase_name").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    changedByProcoreUserId: text("changed_by_procore_user_id"),
    changedByProcoreUserName: text("changed_by_procore_user_name"),
    syncSource: text("sync_source").default("manual").notNull(),
    rawEvent: jsonb("raw_event"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("project_phase_history_project_idx").on(table.projectId),
    index("project_phase_history_changed_at_idx").on(table.changedAt),
    uniqueIndex("project_phase_history_initial_unique")
      .on(table.projectId, table.toPhaseId, table.toPhaseName)
      .where(sql`${table.fromPhaseId} IS NULL AND ${table.fromPhaseName} IS NULL`),
  ]
);

export const projectTeam = pgTable(
  "project_team",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    procoreUserId: text("procore_user_id"),
    procoreUserName: text("procore_user_name"),
    procoreUserEmail: text("procore_user_email"),
    roleName: text("role_name"),
    isActive: boolean("is_active").default(true).notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
    rawRoleData: jsonb("raw_role_data"),
  },
  (table) => [index("project_team_project_idx").on(table.projectId)]
);

export const projectDocuments = pgTable(
  "project_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    procoreDocumentId: text("procore_document_id"),
    name: text("name").notNull(),
    fileUrl: text("file_url"),
    fileSize: bigint("file_size", { mode: "number" }),
    mimeType: text("mime_type"),
    folderPath: text("folder_path"),
    uploadedByProcoreUserName: text("uploaded_by_procore_user_name"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("project_documents_project_idx").on(table.projectId),
    index("project_documents_procore_document_idx").on(table.procoreDocumentId),
  ]
);

export const projectSyncState = pgTable(
  "project_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procoreProjectId: text("procore_project_id").notNull(),
    lastFullRefreshAt: timestamp("last_full_refresh_at", { withTimezone: true }),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("project_sync_state_procore_project_uidx").on(table.procoreProjectId)]
);
