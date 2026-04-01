import { pgTable, uuid, unique } from "drizzle-orm/pg-core";
import { users, userRoleEnum } from "./users.js";
import { offices } from "./offices.js";

export const userOfficeAccess = pgTable(
  "user_office_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    officeId: uuid("office_id")
      .references(() => offices.id)
      .notNull(),
    roleOverride: userRoleEnum("role_override"),
  },
  (table) => [unique().on(table.userId, table.officeId)]
);
