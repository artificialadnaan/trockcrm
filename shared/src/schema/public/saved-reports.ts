import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  jsonb,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { offices } from "./offices.js";
import { REPORT_VISIBILITY, REPORT_ENTITIES } from "../../types/enums.js";

export const reportVisibilityEnum = pgEnum("report_visibility", REPORT_VISIBILITY);
export const reportEntityEnum = pgEnum("report_entity", REPORT_ENTITIES);

export const savedReports = pgTable("saved_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  entity: reportEntityEnum("entity").notNull(),
  config: jsonb("config").notNull(),
  isLocked: boolean("is_locked").default(false).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  officeId: uuid("office_id").references(() => offices.id),
  visibility: reportVisibilityEnum("visibility").default("private").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
