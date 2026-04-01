import { pgTable, uuid, varchar, boolean, timestamp, unique } from "drizzle-orm/pg-core";

export const contactDealAssociations = pgTable(
  "contact_deal_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull(),
    dealId: uuid("deal_id").notNull(),
    role: varchar("role", { length: 100 }),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.contactId, table.dealId)]
);
