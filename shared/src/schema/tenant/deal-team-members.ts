import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { fieldResponders } from "./field-responders.js";

export const dealTeamRoleEnum = pgEnum("deal_team_role", [
  "superintendent",
  "estimator",
  "project_manager",
  "client_services",
  "operations",
  "foreman",
  "other",
]);

export const dealTeamMembers = pgTable(
  "deal_team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    userId: uuid("user_id"),
    contactId: uuid("contact_id"),
    // Email-only member (migration 0193): a superintendent / project_manager who is NOT a CRM user or a
    // directory contact — just a name + email. Such a row carries member_email (and typically member_name)
    // with user_id AND contact_id both NULL, so the corrective-action flow can notify + token-auth them.
    memberName: text("member_name"),
    memberEmail: text("member_email"),
    // Roster LINK (migration 0198): when this assignment was picked from the field_responders roster, this
    // points at that roster row. Nullable — plain email-only / user / contact rows leave it NULL. ON DELETE
    // SET NULL (owned by the migration): removing the roster person clears the link but leaves the
    // assignment (which carries its own copied member_name+member_email) intact. Corrective-action recipient
    // resolution is UNCHANGED — it resolves member_email, not the roster row.
    responderId: uuid("responder_id").references(() => fieldResponders.id, {
      onDelete: "set null",
    }),
    role: dealTeamRoleEnum("role").notNull(),
    assignedBy: uuid("assigned_by"),
    notes: text("notes"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Exactly one of user_id / contact_id identifies a linked identity, OR — for an email-only member —
    // both are NULL and member_email is present. Migration 0193 replaces the old exclusive check with this
    // one so email-only super/PM rows can be stored on the same table (one resolution path).
    check(
      "deal_team_members_identity_check",
      sql`(${table.userId} is not null and ${table.contactId} is null) or (${table.userId} is null and ${table.contactId} is not null) or (${table.userId} is null and ${table.contactId} is null and ${table.memberEmail} is not null)`
    ),
  ]
);
