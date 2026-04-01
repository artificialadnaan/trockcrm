import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { CONTACT_CATEGORIES } from "../../types/enums.js";

export const contactCategoryEnum = pgEnum("contact_category", CONTACT_CATEGORIES);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 20 }),
    mobile: varchar("mobile", { length: 20 }),
    companyName: varchar("company_name", { length: 500 }),
    jobTitle: varchar("job_title", { length: 255 }),
    category: contactCategoryEnum("category").notNull(),
    address: text("address"),
    city: varchar("city", { length: 255 }),
    state: varchar("state", { length: 2 }),
    zip: varchar("zip", { length: 10 }),
    notes: text("notes"),
    touchpointCount: integer("touchpoint_count").default(0).notNull(),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    firstOutreachCompleted: boolean("first_outreach_completed").default(false).notNull(),
    procoreContactId: bigint("procore_contact_id", { mode: "number" }),
    hubspotContactId: varchar("hubspot_contact_id", { length: 50 }),
    normalizedPhone: varchar("normalized_phone", { length: 20 }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("contacts_name_company_idx").on(table.companyName),
  ]
);
