import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { offices } from "./offices.js";
import { users } from "./users.js";

export const publicPhotoTokens = pgTable(
  "public_photo_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").unique().notNull(),
    dealId: uuid("deal_id").notNull(),
    tenantId: uuid("tenant_id").notNull().references(() => offices.id),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").default(0).notNull(),
    // Subset scope (migration 0160): NULL = whole-deal token; non-NULL = only these photo ids.
    photoIds: uuid("photo_ids").array(),
  },
  (table) => [
    index("public_photo_tokens_deal_idx").on(table.dealId),
    index("public_photo_tokens_tenant_deal_idx").on(table.tenantId, table.dealId),
    index("public_photo_tokens_token_idx").on(table.token),
  ]
);
