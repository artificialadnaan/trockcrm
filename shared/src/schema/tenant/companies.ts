import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { contactCategoryEnum } from "./contacts.js";
import { COMPANY_VERIFICATION_STATUSES } from "../../types/enums.js";

export const companyVerificationStatusEnum = pgEnum(
  "company_verification_status",
  COMPANY_VERIFICATION_STATUSES
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 500 }).notNull(),
    slug: varchar("slug", { length: 100 }).unique().notNull(),
    category: contactCategoryEnum("category").notNull(),
    address: text("address"),
    city: varchar("city", { length: 255 }),
    state: varchar("state", { length: 2 }),
    zip: varchar("zip", { length: 10 }),
    phone: varchar("phone", { length: 20 }),
    website: varchar("website", { length: 500 }),
    notes: text("notes"),
    companyVerificationStatus: companyVerificationStatusEnum("company_verification_status"),
    companyVerificationRequestedAt: timestamp("company_verification_requested_at", { withTimezone: true }),
    companyVerificationEmailSentAt: timestamp("company_verification_email_sent_at", { withTimezone: true }),
    companyVerifiedAt: timestamp("company_verified_at", { withTimezone: true }),
    companyVerifiedBy: uuid("company_verified_by"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("companies_name_idx").on(table.name),
    index("companies_category_idx").on(table.category),
    index("companies_verification_status_idx").on(table.companyVerificationStatus),
  ]
);
