import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { offices } from "./offices.js";

// PUBLIC, not per-office — and that is the whole reason this table is separate from the rest of the
// weekly-report schema. The `/wr/:token` viewer arrives with no office context at all: it must resolve a
// token to its office BEFORE it can choose a search_path. Same reasoning that put
// public.field_ai_report_runs (0209) in public. Migration 0222 owns the DDL.
//
// `token` stores a SHA-256 HASH. The raw token exists only inside the URL we email, so reading this
// table cannot recover a live client link. Identical scheme to public.public_photo_tokens (0084).
export const weeklyReportTokens = pgTable(
  "weekly_report_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").unique().notNull(),
    /** Bare uuid: the report lives in an office_* schema, which no public-schema FK can reach. */
    weeklyReportId: uuid("weekly_report_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => offices.id),
    /** Carried on the row so the viewer can pick a search_path from the token alone. */
    officeSlug: text("office_slug").notNull(),
    createdByUserId: uuid("created_by_user_id"),
    /** Set to now() + 180 days at mint. NULL would mean "never expires", which this feature never issues. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("weekly_report_tokens_report_idx").on(table.weeklyReportId),
    index("weekly_report_tokens_tenant_idx").on(table.tenantId, table.weeklyReportId),
  ],
);
