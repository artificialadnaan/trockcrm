import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { EMAIL_DIRECTIONS } from "../../types/enums.js";

export const emailDirectionEnum = pgEnum("email_direction", EMAIL_DIRECTIONS);

export const emails = pgTable("emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  graphMessageId: varchar("graph_message_id", { length: 500 }).unique().notNull(),
  graphConversationId: varchar("graph_conversation_id", { length: 500 }),
  direction: emailDirectionEnum("direction").notNull(),
  fromAddress: varchar("from_address", { length: 255 }).notNull(),
  toAddresses: text("to_addresses").array().notNull(),
  ccAddresses: text("cc_addresses").array(),
  subject: varchar("subject", { length: 1000 }),
  bodyPreview: varchar("body_preview", { length: 500 }),
  bodyHtml: text("body_html"),
  hasAttachments: boolean("has_attachments").default(false).notNull(),
  isStarred: boolean("is_starred").default(false).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  contactId: uuid("contact_id"),
  dealId: uuid("deal_id"),
  assignedEntityType: varchar("assigned_entity_type", { length: 20 }),
  assignedEntityId: uuid("assigned_entity_id"),
  assignmentStatus: varchar("assignment_status", { length: 20 }).default("unassigned").notNull(),
  assignmentConfidence: varchar("assignment_confidence", { length: 20 }),
  assignmentAmbiguityReason: varchar("assignment_ambiguity_reason", { length: 255 }),
  aiSuggestions: jsonb("ai_suggestions").default([]).notNull(),
  threadBindingId: uuid("thread_binding_id"),
  userId: uuid("user_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});
