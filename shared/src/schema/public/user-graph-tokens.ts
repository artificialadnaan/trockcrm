import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { GRAPH_TOKEN_STATUSES } from "../../types/enums.js";

export const graphTokenStatusEnum = pgEnum("graph_token_status", GRAPH_TOKEN_STATUSES);

export const userGraphTokens = pgTable("user_graph_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id)
    .unique()
    .notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").array().notNull(),
  subscriptionId: varchar("subscription_id", { length: 255 }),
  subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
  lastDeltaLink: text("last_delta_link"),
  status: graphTokenStatusEnum("status").default("active").notNull(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
