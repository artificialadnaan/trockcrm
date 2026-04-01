import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
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
  contactId: uuid("contact_id"),
  dealId: uuid("deal_id"),
  userId: uuid("user_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});
