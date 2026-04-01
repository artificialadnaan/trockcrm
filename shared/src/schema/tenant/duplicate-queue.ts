import {
  pgTable,
  pgEnum,
  uuid,
  numeric,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { DUPLICATE_MATCH_TYPES, DUPLICATE_STATUSES } from "../../types/enums.js";

export const duplicateMatchTypeEnum = pgEnum("duplicate_match_type", DUPLICATE_MATCH_TYPES);
export const duplicateStatusEnum = pgEnum("duplicate_status", DUPLICATE_STATUSES);

export const duplicateQueue = pgTable(
  "duplicate_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactAId: uuid("contact_a_id").notNull(),
    contactBId: uuid("contact_b_id").notNull(),
    matchType: duplicateMatchTypeEnum("match_type").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 3, scale: 2 }),
    status: duplicateStatusEnum("status").default("pending").notNull(),
    resolvedBy: uuid("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.contactAId, table.contactBId)]
);
