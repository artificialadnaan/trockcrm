import { pgEnum, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { contacts } from "./contacts.js";
import { deals } from "./deals.js";

export const dealContactRoleEnum = pgEnum("deal_contact_role", ["primary", "secondary"]);

export const dealContacts = pgTable(
  "deal_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    roleOnDeal: dealContactRoleEnum("role_on_deal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("deal_contacts_deal_id_contact_id_key").on(table.dealId, table.contactId),
  ]
);
