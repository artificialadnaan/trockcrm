import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

// Resolve the workspace package specifiers to their src under vitest (mirrors conversion-service.test).
vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/lib/rfpVoteState", async () => import("../../../../shared/src/lib/rfpVoteState.js"));

import { loadRfpVoteDetail } from "../../../src/modules/deals/rfp-vote-detail.js";
import { computeRfpVoteState } from "../../../../shared/src/lib/rfpVoteState.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const DEAL = U("d01");
const ROUND = U("e01");
const ROUND_OLD = U("e00"); // a prior round — must NOT leak into the current tally
const SIDNEY = U("a01");
const JAMES = U("a02");
const TIM = U("a03");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE rfp_votes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      round_event_id uuid NOT NULL,
      voter_user_id uuid,
      voter_email text NOT NULL,
      decision text NOT NULL,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO users (id, display_name) VALUES
      ('${SIDNEY}', 'Sidney Gibson'),
      ('${JAMES}', 'James Helms'),
      ('${TIM}', 'Tim Estimator');
    INSERT INTO rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision, reason, created_at) VALUES
      ('${DEAL}', '${ROUND}', '${SIDNEY}', 'sidney@trockgc.com', 'approve', NULL, '2026-07-02T14:14:00Z'),
      ('${DEAL}', '${ROUND}', '${JAMES}', 'james@trockgc.com', 'reject', 'Margins too thin for this scope', '2026-07-02T14:20:00Z'),
      ('${DEAL}', '${ROUND_OLD}', '${TIM}', 'tim@trockgc.com', 'reject', 'old round', '2026-07-01T09:00:00Z');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

describe("loadRfpVoteDetail", () => {
  it("returns the current round's votes (name-joined, ISO votedAt, createdAt asc) and reconciles rfpVoteState with computeRfpVoteState", async () => {
    const { rfpVotes, rfpVoteState } = await loadRfpVoteDetail(tdb, DEAL, ROUND);

    // Only this round's two votes, oldest first.
    expect(rfpVotes.map((v) => v.voterEmail)).toEqual(["sidney@trockgc.com", "james@trockgc.com"]);
    expect(rfpVotes[0]).toMatchObject({
      voterUserId: SIDNEY,
      voterName: "Sidney Gibson",
      decision: "approve",
      reason: null,
    });
    expect(rfpVotes[1]).toMatchObject({ voterName: "James Helms", decision: "reject", reason: "Margins too thin for this scope" });
    expect(typeof rfpVotes[0].votedAt).toBe("string");
    expect(rfpVotes[0].votedAt).toBe(new Date("2026-07-02T14:14:00Z").toISOString());

    // 1 approve · 1 reject with threshold 2 => still pending.
    expect(rfpVoteState).toMatchObject({ approvals: 1, rejections: 1, outcome: "pending", decidedAt: null });

    // Reconciliation invariant: the state on the payload equals a fresh computeRfpVoteState over the same records.
    expect(rfpVoteState).toEqual(
      computeRfpVoteState(
        rfpVotes.map((v) => ({ voterUserId: v.voterUserId, voterEmail: v.voterEmail, decision: v.decision, reason: v.reason, createdAt: v.votedAt }))
      )
    );
  });

  it("returns empty votes + a pending state when the deal has no open round (null roundEventId)", async () => {
    const { rfpVotes, rfpVoteState } = await loadRfpVoteDetail(tdb, DEAL, null);
    expect(rfpVotes).toEqual([]);
    expect(rfpVoteState).toEqual(computeRfpVoteState([]));
  });

  it("returns empty + zero-state (no throw) when rfp_votes is missing — probing with to_regclass, not a failing SELECT", async () => {
    // Simulate the pre-migration state: rfp_votes table absent; users table present for the JOIN path.
    const rawPg = new PGlite();
    await rawPg.exec(`CREATE TABLE users (id uuid PRIMARY KEY, display_name text);`);
    // Do NOT create rfp_votes — this mirrors a tenant that hasn't run migration 0175 yet.
    const noTableDb = drizzle(rawPg);
    try {
      const { rfpVotes: votes, rfpVoteState: state } = await loadRfpVoteDetail(noTableDb as any, DEAL, ROUND);
      expect(votes).toEqual([]);
      expect(state).toEqual(computeRfpVoteState([]));
    } finally {
      await rawPg.close();
    }
  });

  it("does NOT poison the surrounding transaction when rfp_votes is missing (to_regclass probe never aborts it)", async () => {
    // getDealDetail runs loadRfpVoteDetail inside a tenant TRANSACTION. If it ran a SELECT against a missing
    // rfp_votes, the 42P01 would abort the whole transaction and every later statement would fail with "current
    // transaction is aborted". The to_regclass probe raises nothing, so a follow-up query in the SAME txn still
    // works — this asserts exactly that.
    const rawPg = new PGlite();
    await rawPg.exec(`CREATE TABLE users (id uuid PRIMARY KEY, display_name text);`);
    const noTableDb = drizzle(rawPg);
    try {
      await noTableDb.transaction(async (tx: any) => {
        const { rfpVotes: votes } = await loadRfpVoteDetail(tx, DEAL, ROUND);
        expect(votes).toEqual([]);
        // The transaction must still be usable — this throws "current transaction is aborted" if the probe had
        // instead run a failing SELECT.
        const after = await tx.execute(sql`SELECT 1 AS ok`);
        const afterRows = Array.isArray(after) ? after : (after as { rows?: { ok: number }[] }).rows ?? [];
        expect(Number(afterRows[0]?.ok)).toBe(1);
      });
    } finally {
      await rawPg.close();
    }
  });
});
