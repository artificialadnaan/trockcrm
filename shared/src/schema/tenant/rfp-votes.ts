import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-office RFP approval votes (non-service deals). One row per voter per vote round. A "round" is
 * scoped by round_event_id (= deals.rfp_approval_request_event_id at trigger time) so a cancel/
 * re-trigger starts a fresh tally and old rows never leak into a new round. 2-of-3 majority decides
 * (see shared/src/lib/rfpVoteState.ts — the single reconciliation helper).
 *
 * Cross-schema FKs (deal_id -> office_x.deals(id) ON DELETE CASCADE, voter_user_id ->
 * public.users(id) ON DELETE SET NULL) are declared in migration 0173, NOT here, per the tenant-table
 * convention (Drizzle tenant objects omit cross-schema references). decision is plain text
 * ('approve' | 'reject') matching the no-enum RFP-state convention (migration 0151).
 */
export const rfpVotes = pgTable(
  "rfp_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    roundEventId: uuid("round_event_id").notNull(),
    voterUserId: uuid("voter_user_id"),
    voterEmail: text("voter_email").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One vote per voter per round; enforces "locked on cast". Mirrors migration 0173's
    // CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id).
    uniqueIndex("rfp_votes_deal_round_voter_uq").on(
      table.dealId,
      table.roundEventId,
      table.voterUserId,
    ),
  ],
);
