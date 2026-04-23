import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { ACTIVITY_TYPES } from "../../types/enums.js";
import { users } from "../public/users.js";
import { companies } from "./companies.js";
import { contacts } from "./contacts.js";
import { deals } from "./deals.js";
import { emails } from "./emails.js";
import { leads } from "./leads.js";
import { properties } from "./properties.js";

export const activityTypeEnum = pgEnum("activity_type", ACTIVITY_TYPES);
export const activitySourceEntityEnum = pgEnum("activity_source_entity", [
  "company",
  "property",
  "lead",
  "deal",
  "contact",
  "mailbox",
]);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: activityTypeEnum("type").notNull(),
    responsibleUserId: uuid("responsible_user_id").references(() => users.id).notNull(),
    performedByUserId: uuid("performed_by_user_id").references(() => users.id),
    sourceEntityType: activitySourceEntityEnum("source_entity_type").notNull(),
    sourceEntityId: uuid("source_entity_id").notNull(),
    companyId: uuid("company_id").references(() => companies.id),
    propertyId: uuid("property_id").references(() => properties.id),
    leadId: uuid("lead_id").references(() => leads.id),
    dealId: uuid("deal_id").references(() => deals.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    emailId: uuid("email_id").references(() => emails.id),
    subject: varchar("subject", { length: 500 }),
    body: text("body"),
    outcome: varchar("outcome", { length: 100 }),
    nextStep: text("next_step"),
    nextStepDueAt: timestamp("next_step_due_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("activities_responsible_user_idx").on(table.responsibleUserId, table.occurredAt),
    index("activities_company_idx").on(table.companyId, table.occurredAt),
    index("activities_property_idx").on(table.propertyId, table.occurredAt),
    index("activities_lead_idx").on(table.leadId, table.occurredAt),
    index("activities_deal_idx").on(table.dealId, table.occurredAt),
    index("activities_contact_idx").on(table.contactId, table.occurredAt),
  ]
);
