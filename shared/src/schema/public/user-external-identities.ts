import {
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const externalUserSourceEnum = pgEnum("external_user_source", ["hubspot", "procore"]);

export const userExternalIdentities = pgTable(
  "user_external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    sourceSystem: externalUserSourceEnum("source_system").notNull(),
    externalUserId: varchar("external_user_id", { length: 255 }).notNull(),
    externalEmail: varchar("external_email", { length: 255 }),
    externalDisplayName: varchar("external_display_name", { length: 255 }),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_external_identities_source_uidx").on(table.sourceSystem, table.externalUserId),
  ]
);
