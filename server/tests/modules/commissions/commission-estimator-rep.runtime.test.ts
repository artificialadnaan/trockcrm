import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, type SQL } from "drizzle-orm";
import { getRepCommissionDashboard, repSql } from "../../../src/modules/commissions/reporting-service.js";

/**
 * REAL-SQL (PGlite) commission-SAFETY proof for PR 2. The commission deal FILTER is estimator-aware:
 * filtering by a person now includes deals they ESTIMATED. This is a VIEW-FILTER change ONLY — it must
 * NOT change who earns/gets paid:
 *   - the PIPELINE branch (unsigned deals) widens to deals the person owns OR estimated. Owned rows use the
 *     owner rate; estimator-only rows use the estimator user's own rate.
 *   - the EARNED branch keys on dsc.rep_user_id (the commission earner) and is UNCHANGED — an estimator
 *     does NOT inherit the owner's earned commission.
 * Executes the real getRepCommissionDashboard query (incl. its snapshot write).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP_A = U("a01"); // owner, commission rate 0.10
const REP_B = U("b01"); // estimator-only, commission rate 0.05
const ST = U("57001");
const D = { pipelineEstB: U("d01"), signedA_estB: U("d02"), unassignedEstB: U("d03") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE properties (id uuid PRIMARY KEY, name text, address text);
    CREATE TABLE user_commission_settings (user_id uuid PRIMARY KEY, commission_rate numeric, rolling_floor numeric NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE commission_deal_snapshots (
      deal_id uuid, rep_user_id uuid, last_commission_amount numeric, last_computed_at timestamptz,
      PRIMARY KEY (deal_id, rep_user_id)
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, name text, assigned_rep_id uuid, estimator_user_id uuid, sales_source_user_id uuid,
      company_id uuid, property_id uuid, property_address text, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      won_closed_date date,
      expected_close_date date, stage_entered_at timestamptz, updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric,
      change_order_total numeric
    );
    CREATE TABLE deal_signed_commissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, rep_user_id uuid,
      source_value_kind text, source_value_amount numeric, applied_rate numeric, amount numeric,
      attribution_role text NOT NULL DEFAULT 'owner',
      contract_signed_date_at_signing date
    );
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, is_active boolean NOT NULL DEFAULT true, role text NOT NULL DEFAULT 'rep');

    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST}', 'opportunity');
    INSERT INTO user_commission_settings (user_id, commission_rate, is_active) VALUES
      ('${REP_A}', 0.10, true), ('${REP_B}', 0.05, true);
    -- Both reps are ACTIVE internal CRM users, so the estimator-rate join (gated on users.is_active +
    -- role <> 'field_contractor') behaves exactly as before this gate was added.
    INSERT INTO users (id, display_name, is_active, role) VALUES
      ('${REP_A}', 'Alice', true, 'rep'), ('${REP_B}', 'Bob', true, 'rep');
    -- unsigned pipeline deal: assigned A, estimated by B
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, bid_estimate, change_order_total, created_at) VALUES
      ('${D.pipelineEstB}', 'P-1', 'Pipeline est B', '${REP_A}', '${REP_B}', '${ST}', 100000, 0, '2026-02-01T00:00:00Z');
    -- signed deal: assigned A (earns), estimated by B; an earned commission row attributed to A
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.signedA_estB}', 'S-1', 'Signed A est B', '${REP_A}', '${REP_B}', '${ST}', '2026-03-15T00:00:00Z', 60000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.signedA_estB}', '${REP_A}', 'awarded', 60000, 0.10, 7000, '2026-03-15');
    -- UNASSIGNED open deal estimated by B (no owner) — the estimator-aware pipeline filter surfaces it
    -- for B; its snapshot rep_id is NULL, which must NOT crash the snapshot write (Codex P2 / round 1).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, bid_estimate, created_at) VALUES
      ('${D.unassignedEstB}', 'U-1', 'Unassigned est B', NULL, '${REP_B}', '${ST}', 30000, '2026-02-05T00:00:00Z');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

const RANGE = { from: "2026-01-01", to: "2026-06-04" };

describe("commission report deal filter is estimator-aware with per-estimator potential", () => {
  it("Bob (estimator-only) sees the pipeline deal he ESTIMATED at his own estimator rate", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_B, ...RANGE });
    const pipeline = dash.deals.find((d) => d.dealId === D.pipelineEstB);
    expect(pipeline).toBeDefined(); // estimator-aware: surfaces despite Bob not owning it
    expect(pipeline?.isEarned).toBe(false);
    // 100000 * Bob's 0.05 estimator rate = 5000.00, independent of Alice's 10% owner rate.
    expect(pipeline?.commission).toBeCloseTo(5000, 2);
    expect(pipeline?.commissionRate).toBeCloseTo(0.05, 6);
    // Includes the unassigned estimated deal below too: 100000×0.05 + 30000×0.05 = 6500.00.
    expect(dash.summary.inPipeline).toBeCloseTo(6500, 2);
  });

  it("Bob does NOT inherit the owner's EARNED commission (attribution keys on dsc.rep_user_id)", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_B, ...RANGE });
    expect(dash.deals.find((d) => d.dealId === D.signedA_estB && d.isEarned)).toBeUndefined();
    expect(dash.summary.earned).toBeCloseTo(0, 2); // Bob earned nothing, though he estimated a signed deal
  });

  it("does NOT crash on an UNASSIGNED deal Bob estimated (snapshot write guards null rep)", async () => {
    // Before the snapshot guard, a NULL assigned_rep_id row tried to INSERT ''::uuid and 22P02-crashed
    // the whole request. The deal surfaces (Bob estimated it) at Bob's own estimator rate even with no owner.
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_B, ...RANGE });
    const row = dash.deals.find((d) => d.dealId === D.unassignedEstB);
    expect(row).toBeDefined();
    expect(row?.commission).toBeCloseTo(1500, 2); // 30000 × 0.05
  });

  it("does NOT show the OWNER's snapshot delta on a deal the rep only estimated", async () => {
    // Simulate Alice (the owner) having viewed before: her snapshot for the deal she owns.
    await tdb.execute(sql`DELETE FROM commission_deal_snapshots`);
    await tdb.execute(sql`
      INSERT INTO commission_deal_snapshots (deal_id, rep_user_id, last_commission_amount, last_computed_at)
      VALUES (${D.pipelineEstB}::uuid, ${REP_A}::uuid, 8000, now())
    `);
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_B, ...RANGE });
    const row = dash.deals.find((d) => d.dealId === D.pipelineEstB);
    expect(row).toBeDefined();
    // Bob only ESTIMATED this deal; the snapshot read is keyed on Bob, so Alice's "since last update"
    // delta is NOT surfaced to Bob.
    expect(row?.deltaCommission ?? null).toBeNull();
  });

  it("an estimator's dashboard view does NOT refresh the OWNER's snapshot (no cross-rep clobber)", async () => {
    // Bob estimated D.pipelineEstB (owned by Alice). Bob viewing his dashboard may upsert Bob's estimator
    // projection snapshot, but must not upsert Alice's owner snapshot.
    await tdb.execute(sql`DELETE FROM commission_deal_snapshots`);
    await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_B, ...RANGE });
    const snaps = (await tdb
      .execute(sql`SELECT deal_id::text AS deal_id, rep_user_id::text AS rep_user_id FROM commission_deal_snapshots`)
      .then((r: unknown) => ((r as { rows?: unknown[] })?.rows ?? r) as Array<{ deal_id: string; rep_user_id: string }>));
    expect(snaps.some((s) => s.deal_id === D.pipelineEstB && s.rep_user_id === REP_A)).toBe(false);
    expect(snaps.some((s) => s.deal_id === D.pipelineEstB && s.rep_user_id === REP_B)).toBe(true);
    // Sanity: when ALICE (the owner) views her own dashboard, HER snapshot for that deal IS written.
    await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_A, ...RANGE });
    const after = (await tdb
      .execute(sql`SELECT deal_id::text AS deal_id, rep_user_id::text AS rep_user_id FROM commission_deal_snapshots`)
      .then((r: unknown) => ((r as { rows?: unknown[] })?.rows ?? r) as Array<{ deal_id: string; rep_user_id: string }>));
    expect(after.some((s) => s.deal_id === D.pipelineEstB && s.rep_user_id === REP_A)).toBe(true);
  });

  it("Alice (owner) is unchanged: earns her signed commission and sees her pipeline deal at her rate", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_A, ...RANGE });
    expect(dash.summary.earned).toBeCloseTo(7000, 2); // dsc.amount, unchanged
    expect(dash.deals.find((d) => d.dealId === D.pipelineEstB)?.commission).toBeCloseTo(10000, 2);
  });
});

describe("repSql (the shared commission deal filter, used by getCommissionPotential/Summary) is estimator-aware", () => {
  const ids = (clause: SQL): Promise<string[]> =>
    tdb.execute(sql`SELECT d.id::text AS id FROM deals d WHERE TRUE ${clause} ORDER BY d.id`)
      .then((r: unknown) =>
        ((Array.isArray(r) ? r : (r as { rows?: unknown[] })?.rows ?? []) as Array<{ id: string }>).map((x) => x.id)
      );

  it("filtering commissions by Bob (estimator-only) matches deals he estimated", async () => {
    const rows = await ids(repSql({ role: "rep", userId: REP_B }));
    expect(rows).toEqual([D.pipelineEstB, D.signedA_estB, D.unassignedEstB].sort()); // all estimated by Bob
  });
  it("an uninvolved person matches nothing", async () => {
    const rows = await ids(repSql({ role: "rep", userId: U("c01") }));
    expect(rows).toEqual([]);
  });
});
