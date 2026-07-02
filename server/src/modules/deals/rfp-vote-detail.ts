import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { rfpVotes, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { computeRfpVoteState, type RfpVoteRecord } from "@trock-crm/shared/lib/rfpVoteState";

type TenantDb = NodePgDatabase<typeof schema>;

/** One recorded vote as shown on the deal detail card + the /rfp-vote page (name-joined for display). */
export type RfpVoteView = {
  voterUserId: string | null;
  voterName: string | null;
  voterEmail: string;
  decision: "approve" | "reject";
  reason: string | null;
  votedAt: string;
};

/**
 * Loads the CURRENT round's votes for a deal + the derived vote state. Scoped by round_event_id (the deal's
 * rfp_approval_request_event_id) so a re-triggered round starts a clean tally and old rows never leak in.
 * rfpVoteState is computed by the ONE shared helper (computeRfpVoteState) — the reconciliation invariant: the
 * value the card renders is the same value the fire-on-2 decision + escalation summary use.
 */
export async function loadRfpVoteDetail(
  tenantDb: TenantDb,
  dealId: string,
  roundEventId: string | null
): Promise<{ rfpVotes: RfpVoteView[]; rfpVoteState: ReturnType<typeof computeRfpVoteState> }> {
  if (!roundEventId) {
    return { rfpVotes: [], rfpVoteState: computeRfpVoteState([]) };
  }

  const rows = await tenantDb
    .select({
      voterUserId: rfpVotes.voterUserId,
      voterName: users.displayName,
      voterEmail: rfpVotes.voterEmail,
      decision: rfpVotes.decision,
      reason: rfpVotes.reason,
      createdAt: rfpVotes.createdAt,
    })
    .from(rfpVotes)
    .leftJoin(users, eq(users.id, rfpVotes.voterUserId))
    .where(and(eq(rfpVotes.dealId, dealId), eq(rfpVotes.roundEventId, roundEventId)))
    .orderBy(asc(rfpVotes.createdAt));

  const records: RfpVoteRecord[] = rows.map((r) => ({
    voterUserId: r.voterUserId,
    voterEmail: r.voterEmail,
    decision: r.decision as "approve" | "reject",
    reason: r.reason,
    createdAt: r.createdAt,
  }));

  const rfpVoteState = computeRfpVoteState(records);
  const votesView: RfpVoteView[] = rows.map((r) => ({
    voterUserId: r.voterUserId,
    voterName: r.voterName ?? null,
    voterEmail: r.voterEmail,
    decision: r.decision as "approve" | "reject",
    reason: r.reason,
    votedAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));

  return { rfpVotes: votesView, rfpVoteState };
}
