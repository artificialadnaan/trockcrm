import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

// Per-office (cloned into every office_* schema). A GLOBAL managed roster of field Superintendents &
// Project Managers ("field responders") — the managed source for corrective-action recipient emails,
// replacing per-deal retyping. deal_team_members.responder_id links a deal assignment to a roster row
// (the assignment still COPIES the person's name+email at assign time, so corrective-action recipient
// resolution is unchanged — responder_id is just the link). The table/index DDL is owned by migration
// 0198; the `role` CHECK and the active-email partial unique index are mirrored here so db:generate sees
// parity. `role` is a bare text column with an IN-list check (matching scorecard_corrective_actions'
// item_type / status style), NOT a pgEnum.
export const fieldResponders = pgTable(
  "field_responders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    /** 'superintendent' | 'project_manager' */
    role: text("role").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "field_responders_role_check",
      sql`${table.role} IN ('superintendent', 'project_manager')`,
    ),
    // Case-insensitive email uniqueness among ACTIVE rows only — mirrors migration 0198's
    // field_responders_active_email_uidx. A deactivated person's email is free to be re-added.
    uniqueIndex("field_responders_active_email_uidx")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.isActive} = TRUE`),
  ],
);
