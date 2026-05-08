import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { files } from "./files.js";

export const userStarredFiles = pgTable(
  "user_starred_files",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    starredAt: timestamp("starred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "user_starred_files_user_id_file_id_pk",
      columns: [table.userId, table.fileId],
    }),
    index("user_starred_files_file_idx").on(table.fileId),
  ]
);
