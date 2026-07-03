import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getStaleDeals } from "../../../src/modules/reports/service.js";

/**
 * REAL-SQL (PGlite) proof that getStaleDeals' estimator-aware rep filter (PR 2) surfaces deals the
 * filtered person ESTIMATED — INCLUDING deals whose assigned_rep_id is NULL (rep is only the estimator).
 * Codex P2 (#625): the query JOINs users on d.assigned_rep_id; an INNER join would silently drop the
 * unassigned-but-estimated row before the staleness engine returns it, so the join must be LEFT.
 * This executes the real query against a faithful schema and asserts the unassigned-estimated stale
 * deal appears (it would NOT under the pre-fix INNER join).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP_A = U("a01"); // owner
const REP_B = U("b01"); // estimator (and owner of one deal)
const ST = U("57001");
const NOW = new Date("2026-06-04T12:00:00Z");
const OLD = "2024-01-01T00:00:00Z"; // ~2.4y in 'opportunity' -> well past the director SLA threshold
const D = {
  estB_unassigned: U("d01"), // assigned NULL, estimated by B  -> the Codex case
  estB_ownedA: U("d02"), // assigned A, estimated by B
  ownedB: U("d03"), // assigned B, no estimator
  ownedA: U("d04"), // assigned A, no estimator (B not involved)
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, name text NOT NULL, stage_id uuid NOT NULL,
      assigned_rep_id uuid, estimator_user_id uuid, sales_source_user_id uuid, workflow_route text DEFAULT 'normal',
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, expected_close_date date, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds bigint, on_hold_accumulated_seconds_at_stage_entry bigint,
      stage_entered_at timestamptz, bid_board_stage_entered_at timestamptz,
      bid_board_stage_slug text, bid_board_stage_status text, region_classification text,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric,
      change_order_total numeric, updated_at timestamptz
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice'), ('${REP_B}','Bob');
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES ('${ST}','opportunity','Opportunity', false);
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, estimator_user_id, stage_entered_at, bid_estimate, updated_at) VALUES
      ('${D.estB_unassigned}','S-1','Est B unassigned', '${ST}', NULL,      '${REP_B}', '${OLD}', 50000, '${OLD}'),
      ('${D.estB_ownedA}',    'S-2','Est B owned A',     '${ST}', '${REP_A}','${REP_B}', '${OLD}', 60000, '${OLD}'),
      ('${D.ownedB}',         'S-3','Owned B',           '${ST}', '${REP_B}', NULL,      '${OLD}', 70000, '${OLD}'),
      ('${D.ownedA}',         'S-4','Owned A',           '${ST}', '${REP_A}', NULL,      '${OLD}', 80000, '${OLD}');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("getStaleDeals estimator-aware rep filter preserves unassigned-but-estimated deals", () => {
  it("filtering by Bob surfaces deals Bob owns AND estimated — including an UNASSIGNED estimated deal", async () => {
    const rows = await getStaleDeals(tdb, { repId: REP_B, now: NOW });
    const ids = new Set(rows.map((r) => r.dealId));
    // The Codex case: assigned_rep_id IS NULL, Bob is only the estimator. The LEFT join keeps it.
    expect(ids.has(D.estB_unassigned)).toBe(true);
    expect(ids.has(D.estB_ownedA)).toBe(true); // estimator-aware
    expect(ids.has(D.ownedB)).toBe(true); // Bob owns
    expect(ids.has(D.ownedA)).toBe(false); // Bob not involved
    // The unassigned row maps to a friendly "Unassigned" rep name (mapper handles the null).
    expect(rows.find((r) => r.dealId === D.estB_unassigned)?.repName).toBe("Unassigned");
  });

  it("filtering by Alice (owner) is unchanged — her owned deals appear, Bob's estimator-only one does not", async () => {
    const rows = await getStaleDeals(tdb, { repId: REP_A, now: NOW });
    const ids = new Set(rows.map((r) => r.dealId));
    expect(ids.has(D.ownedA)).toBe(true);
    expect(ids.has(D.estB_ownedA)).toBe(true); // Alice owns it (Bob estimated)
    expect(ids.has(D.ownedB)).toBe(false); // Alice not involved
    expect(ids.has(D.estB_unassigned)).toBe(false); // not Alice's
  });
});
