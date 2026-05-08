import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { files } from "./files.js";

export const fileLinks = pgTable(
  "file_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    unique().on(table.fileId, table.entityType, table.entityId),
    index("file_links_file_idx").on(table.fileId),
    index("file_links_entity_idx").on(table.entityType, table.entityId),
  ]
);
