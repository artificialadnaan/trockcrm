import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { rfpVotes, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { computeRfpVoteState, type RfpVoteRecord } from "@trock-crm/shared/lib/rfpVoteState";
import { unwrapExecRows } from "../../lib/exec-rows.js";

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

  // Probe for the table with to_regclass BEFORE querying it. If migration 0176 has not been applied yet, a
  // direct SELECT raises Postgres 42P01 — and because getDealDetail runs this inside a tenant TRANSACTION, that
  // error POISONS the whole transaction ("current transaction is aborted, commands ignored until end of
  // transaction block"), so every later statement in the detail load fails too — a try/catch around the SELECT
  // can't undo that. to_regclass returns NULL (no error, no abort) for a missing relation, so we bail cleanly.
  // It resolves against the tenant search_path, exactly how the rfpVotes table itself is queried.
  const probe = await tenantDb.execute(sql`SELECT to_regclass('rfp_votes') AS reg`);
  const probeRows = unwrapExecRows<{ reg: string | null }>(probe);
  if (probeRows[0]?.reg == null) {
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
