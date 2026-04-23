import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { deals } from "./deals.js";

export const emailThreadBindings = pgTable(
  "email_thread_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxAccountId: uuid("mailbox_account_id").notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerConversationId: varchar("provider_conversation_id", { length: 500 }),
    normalizedSubject: varchar("normalized_subject", { length: 500 }),
    participantFingerprint: varchar("participant_fingerprint", { length: 500 }),
    dealId: uuid("deal_id").references(() => deals.id),
    projectId: uuid("project_id"),
    bindingSource: varchar("binding_source", { length: 32 }).notNull(),
    confidence: varchar("confidence", { length: 16 }).notNull(),
    assignmentReason: varchar("assignment_reason", { length: 255 }),
    provisionalUntil: timestamp("provisional_until", { withTimezone: true }),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    detachedAt: timestamp("detached_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "email_thread_bindings_single_target_chk",
      sql`((${table.dealId} IS NOT NULL)::int + (${table.projectId} IS NOT NULL)::int) = 1`
    ),
    check(
      "email_thread_bindings_identity_chk",
      sql`${table.providerConversationId} IS NOT NULL OR (${table.normalizedSubject} IS NOT NULL AND ${table.participantFingerprint} IS NOT NULL)`
    ),
    uniqueIndex("uq_email_thread_bindings_active_conversation")
      .on(table.mailboxAccountId, table.provider, table.providerConversationId)
      .where(sql`${table.detachedAt} IS NULL AND ${table.providerConversationId} IS NOT NULL`),
    uniqueIndex("uq_email_thread_bindings_active_provisional")
      .on(table.mailboxAccountId, table.provider, table.normalizedSubject, table.participantFingerprint)
      .where(sql`${table.detachedAt} IS NULL AND ${table.providerConversationId} IS NULL`),
  ]
);
