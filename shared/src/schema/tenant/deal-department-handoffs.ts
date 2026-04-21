import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { deals } from "./deals.js";

export const dealDepartmentHandoffs = pgTable("deal_department_handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").references(() => deals.id).notNull(),
  fromDepartment: varchar("from_department", { length: 40 }).notNull(),
  toDepartment: varchar("to_department", { length: 40 }).notNull(),
  effectiveOwnerUserId: uuid("effective_owner_user_id").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptanceStatus: varchar("acceptance_status", { length: 20 }).default("pending").notNull(),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
