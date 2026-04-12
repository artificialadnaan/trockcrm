import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const procoreOauthTokens = pgTable("procore_oauth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").array().notNull().default([]),
  connectedAccountEmail: text("connected_account_email"),
  connectedAccountName: text("connected_account_name"),
  status: text("status").notNull().default("active"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
