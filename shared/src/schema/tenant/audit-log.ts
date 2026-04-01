import {
  pgTable,
  pgEnum,
  bigserial,
  uuid,
  varchar,
  jsonb,
  inet,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { AUDIT_ACTIONS } from "../../types/enums.js";

export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTIONS);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tableName: varchar("table_name", { length: 100 }).notNull(),
    recordId: uuid("record_id").notNull(),
    action: auditActionEnum("action").notNull(),
    changedBy: uuid("changed_by"),
    changes: jsonb("changes"),
    fullRow: jsonb("full_row"),
    ipAddress: inet("ip_address"),
    userAgent: varchar("user_agent", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_record_idx").on(table.tableName, table.recordId, table.createdAt),
    index("audit_user_idx").on(table.changedBy, table.createdAt),
    index("audit_time_idx").on(table.createdAt),
  ]
);
