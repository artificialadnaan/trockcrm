import {
  pgTable,
  pgEnum,
  uuid,
  bigint,
  varchar,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { offices } from "./offices.js";
import { users } from "./users.js";

export const procoreReconciliationStatusEnum = pgEnum("procore_reconciliation_status", ["linked", "ignored"]);

export const procoreReconciliationState = pgTable(
  "procore_reconciliation_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    procoreProjectId: bigint("procore_project_id", { mode: "number" }).notNull(),
    dealId: uuid("deal_id"),
    status: procoreReconciliationStatusEnum("status").notNull(),
    matchReason: text("match_reason"),
    matchSnapshot: jsonb("match_snapshot").default({}).notNull(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("procore_reconciliation_state_scope_idx").on(
      table.officeId,
      table.procoreProjectId,
      sql`coalesce(${table.dealId}, '00000000-0000-0000-0000-000000000000'::uuid)`
    ),
  ]
);
