import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";
import { offices } from "./offices.js";
import { users } from "./users.js";

export const hubspotOwnerMappings = pgTable("hubspot_owner_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  hubspotOwnerId: varchar("hubspot_owner_id", { length: 64 }).notNull().unique(),
  hubspotOwnerEmail: varchar("hubspot_owner_email", { length: 320 }),
  userId: uuid("user_id").references(() => users.id),
  officeId: uuid("office_id").references(() => offices.id),
  mappingStatus: varchar("mapping_status", { length: 32 }).notNull().default("pending"),
  failureReasonCode: varchar("failure_reason_code", { length: 64 }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
