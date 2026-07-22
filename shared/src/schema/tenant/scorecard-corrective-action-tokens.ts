import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";

// Per-office (cloned into every office_* schema). One recipient-bound web token per (scorecard, recipient):
// grants an email-only superintendent / project_manager access to that scorecard's corrective-action flow
// without a login. Only the sha256 hash of the raw token is stored (token_hash); the raw value is emailed
// once. Mirrors the public_photo_tokens shape (hash at rest, expiry). The FK (scorecard_id ->
// field_scorecards ON DELETE CASCADE) and the token_hash uniqueness are owned by migration 0191; Drizzle
// declares the unique so db:generate sees parity.
export const scorecardCorrectiveActionTokens = pgTable(
  "scorecard_corrective_action_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scorecardId: uuid("scorecard_id").notNull(),
    /** sha256(rawToken) hex — the raw token is never persisted. */
    tokenHash: text("token_hash").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    /** 'superintendent' | 'project_manager' */
    role: text("role").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("scorecard_corrective_action_tokens_token_hash_key").on(table.tokenHash),
    index("scorecard_corrective_action_tokens_scorecard_idx").on(table.scorecardId),
  ],
);
