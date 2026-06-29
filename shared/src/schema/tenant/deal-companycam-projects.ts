import { pgTable, uuid, varchar, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Join table making a deal 1:many to CompanyCam projects (a project stays 1:1 to a deal via the
 * UNIQUE on companycam_project_id). This is the single source of truth for deal <-> CompanyCam-project
 * links; the legacy scalar `deals.companycamProjectId` is deprecated (no longer read/written) and dropped
 * in a later migration.
 */
export const dealCompanycamProjects = pgTable(
  "deal_companycam_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    companycamProjectId: varchar("companycam_project_id", { length: 50 }).notNull(),
    projectName: text("project_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdByUserId: uuid("created_by_user_id"),
  },
  (table) => [
    uniqueIndex("deal_companycam_projects_ccid_key").on(table.companycamProjectId),
    index("deal_companycam_projects_deal_idx").on(table.dealId),
  ]
);
