import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { computeRepEarnedFloorGate } from "../../../src/modules/commissions/floor-gate.js";

/**
 * REAL-SQL (PGlite) proof of the floor-gate SALES-SOURCE qualifying leg.
 *
 * A service deal sourced by SRC (sales_source_user_id = SRC) but OWNED by SVC must contribute
 * its full value to SRC's qualifyingRevenue, even though SRC has no assigned_rep_id ownership
 * of the deal. The source leg uses its own signed-date predicate (COALESCE(contract_signed_at::date,
 * contract_signed_date)) — there is no lateral owner-row join for a source rep.
 *
 * Owner-only reps (SVC, OTHER) are unaffected; existing floor-gate invariants hold.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const SRC = U("c01"); // mixed source rep; floor 50000 — has sales_source dsc rows
const SVC = U("c02"); // service-rep who OWNS the sourced deals; floor 0
const OTHER = U("c03"); // rep who owns nothing and sources nothing; floor 0
const SOLO = U("c04"); // sources a deal but has NO sales_source dsc row (no rate config / skipped)
const SELF = U("c05"); // both owns AND sources one deal (owner == source); floor 50000
const REASSIGN = U("c06"); // holds a sales_source row on a deal LATER reassigned to them (now its owner)

const ST_OPEN = U("68001"); // 'opportunity'
const ST_LOST = U("68002"); // 'lost'

const D = {
  sourced1: U("e01"), // signed, non-lost, active, owned by SVC, sourced by SRC, $100,000 — has dsc row
  sourcedUnsigned: U("e02"), // no contract date — sourced by SRC but unsigned -> must NOT count
  sourcedLost: U("e03"), // lost stage + sourced by SRC -> must NOT count
  sourcedTest: U("e04"), // is_test_data=true + sourced by SRC -> must NOT count
  sourcedOnHold: U("e05"), // on_hold=true + sourced by SRC -> must NOT count
  svcOwned: U("e06"), // owned by SVC, no sales_source -> must NOT credit SRC
  sourcedOld: U("e07"), // sourced by SRC, signed 2025 (before 2026 RANGE) — has dsc row
  selfOwned: U("e08"), // owned AND sourced by SELF, signed 2027; no sales_source dsc row (owner==source skip)
  soloSourced: U("e09"), // sourced by SOLO, signed 2027; NO dsc row (SOLO has no rate config)
  reassigned: U("e10"), // owned by REASSIGN now AND has REASSIGN's earlier sales_source row (reassignment)
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

const RANGE = { from: "2026-01-01", to: "2026-12-31" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE properties (id uuid PRIMARY KEY, name text, address text);
    CREATE TABLE users (
      id uuid PRIMARY KEY, display_name text, is_active boolean NOT NULL DEFAULT true,
      role text NOT NULL DEFAULT 'rep', reports_to uuid, is_test_data boolean NOT NULL DEFAULT false
    );
    CREATE TABLE user_commission_settings (
      user_id uuid PRIMARY KEY, commission_rate numeric NOT NULL DEFAULT 0,
      rolling_floor numeric NOT NULL DEFAULT 0, override_rate numeric NOT NULL DEFAULT 0,
      estimated_margin_rate numeric NOT NULL DEFAULT 0.30, min_margin_percent numeric NOT NULL DEFAULT 0.20,
      new_customer_share_floor numeric NOT NULL DEFAULT 0.10, new_customer_window_months integer NOT NULL DEFAULT 6,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE commission_deal_snapshots (
      deal_id uuid, rep_user_id uuid, last_commission_amount numeric, last_computed_at timestamptz,
      PRIMARY KEY (deal_id, rep_user_id)
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, name text, assigned_rep_id uuid, estimator_user_id uuid,
      sales_source_user_id uuid,
      company_id uuid, property_id uuid, property_address text, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      won_closed_date date,
      expected_close_date date, bid_due_date timestamptz, stage_entered_at timestamptz, updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric,
      change_order_total numeric
    );
    CREATE TABLE deal_signed_commissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, rep_user_id uuid,
      source_value_kind text, source_value_amount numeric, applied_rate numeric, amount numeric,
      attribution_role text NOT NULL DEFAULT 'owner',
      contract_signed_date_at_signing date
    );

    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('${ST_OPEN}', 'opportunity'),
      ('${ST_LOST}', 'lost');

    INSERT INTO users (id, display_name, is_active, role) VALUES
      ('${SRC}', 'Source Rep', true, 'rep'),
      ('${SVC}', 'Service Rep', true, 'rep'),
      ('${OTHER}', 'Other Rep', true, 'rep'),
      ('${SOLO}', 'Solo Source Rep', true, 'rep'),
      ('${SELF}', 'Self Source Rep', true, 'rep'),
      ('${REASSIGN}', 'Reassigned Rep', true, 'rep');

    INSERT INTO user_commission_settings (user_id, commission_rate, rolling_floor, override_rate) VALUES
      ('${SRC}', 0.005, 50000, 0),
      ('${SVC}', 0.030, 0, 0),
      ('${OTHER}', 0.030, 0, 0),
      ('${SOLO}', 0.005, 10000, 0),
      ('${SELF}', 0.005, 50000, 0),
      ('${REASSIGN}', 0.005, 50000, 0);

    -- D.sourced1: signed 2026-04-01, non-lost, active, owned by SVC, sourced by SRC, $100k
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.sourced1}', 'SS-1', 'Sourced signed', '${SVC}', '${SRC}', '${ST_OPEN}',
      '2026-04-01T00:00:00Z', 100000, '2026-01-10T00:00:00Z');

    -- D.sourcedUnsigned: owned SVC, sourced SRC, NO contract date -> must NOT count
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      awarded_amount, created_at)
    VALUES ('${D.sourcedUnsigned}', 'SS-2', 'Sourced unsigned', '${SVC}', '${SRC}', '${ST_OPEN}',
      50000, '2026-01-10T00:00:00Z');

    -- D.sourcedLost: sourced by SRC but lost stage -> must NOT count
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.sourcedLost}', 'SS-3', 'Sourced lost', '${SVC}', '${SRC}', '${ST_LOST}',
      '2026-04-01T00:00:00Z', 50000, '2026-01-10T00:00:00Z');

    -- D.sourcedTest: sourced by SRC but is_test_data=true -> must NOT count
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      is_test_data, contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.sourcedTest}', 'SS-4', 'Sourced test', '${SVC}', '${SRC}', '${ST_OPEN}',
      true, '2026-04-01T00:00:00Z', 50000, '2026-01-10T00:00:00Z');

    -- D.sourcedOnHold: sourced by SRC but on_hold=true -> must NOT count (reportable filter)
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      on_hold, contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.sourcedOnHold}', 'SS-5', 'Sourced on-hold', '${SVC}', '${SRC}', '${ST_OPEN}',
      true, '2026-04-01T00:00:00Z', 50000, '2026-01-10T00:00:00Z');

    -- D.svcOwned: owned by SVC, no sales_source_user_id -> must NOT appear in SRC qualifying
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id,
      contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.svcOwned}', 'SS-6', 'SVC owned only', '${SVC}', '${ST_OPEN}',
      '2026-04-01T00:00:00Z', 75000, '2026-01-10T00:00:00Z');

    -- D.sourcedOld: sourced by SRC but signed 2025-11-01 (before 2026 RANGE) -> only counts in open/2025 window
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.sourcedOld}', 'SS-7', 'Sourced old', '${SVC}', '${SRC}', '${ST_OPEN}',
      '2025-11-01T00:00:00Z', 80000, '2025-01-10T00:00:00Z');

    -- D.selfOwned: SELF both owns AND sources this deal (signed 2027). No sales_source dsc row is minted
    -- when owner==source (calculateCommissionForDeal skips the source cut). Used to prove the new
    -- dsc-row-based source leg does NOT double-count the deal into the owner leg.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.selfOwned}', 'SS-8', 'SELF self-sourced', '${SELF}', '${SELF}', '${ST_OPEN}',
      '2027-06-01T00:00:00Z', 200000, '2027-01-10T00:00:00Z');
    -- Intentionally NO deal_signed_commissions row for SELF/sales_source on D.selfOwned.

    -- D.soloSourced: SOLO is the sales_source_user_id but has NO dsc row (no rate configured / skipped).
    -- Used to prove the source leg credits 0 without a minted row (phantom-credit scenario).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.soloSourced}', 'SS-9', 'Solo sourced no row', '${SVC}', '${SOLO}', '${ST_OPEN}',
      '2027-06-01T00:00:00Z', 120000, '2027-01-10T00:00:00Z');
    -- Intentionally NO deal_signed_commissions row for SOLO on D.soloSourced.

    -- D.reassigned: REASSIGN sourced this deal earlier (has a sales_source dsc row), then the deal was
    -- REASSIGNED to REASSIGN — so they are now its assigned_rep AND still hold the sales_source row.
    -- The owner leg counts it via ownership; the source leg must EXCLUDE it (assigned_rep_id = repId) to
    -- avoid a double-count.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, sales_source_user_id, stage_id,
      contract_signed_at, awarded_amount, created_at)
    VALUES ('${D.reassigned}', 'SS-10', 'Reassigned onto own source', '${REASSIGN}', '${REASSIGN}', '${ST_OPEN}',
      '2027-06-01T00:00:00Z', 70000, '2027-01-10T00:00:00Z');

    -- sales_source dsc rows.
    -- The new source leg keys exclusively on these rows (not d.sales_source_user_id), so they MUST exist
    -- for D.sourced1 and D.sourcedOld to appear in SRC's qualifying revenue.
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, attribution_role, source_value_amount,
      amount, applied_rate, contract_signed_date_at_signing)
    VALUES
      ('${D.sourced1}', '${SRC}', 'sales_source', 100000, 500, 0.005, '2026-04-01'),
      ('${D.sourcedOld}', '${SRC}', 'sales_source', 80000, 400, 0.005, '2025-11-01'),
      ('${D.reassigned}', '${REASSIGN}', 'sales_source', 70000, 350, 0.005, '2027-06-01');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("computeRepEarnedFloorGate – sales-source qualifying leg", () => {
  it("credits a sourced service deal to the source rep's qualifying revenue at full value", async () => {
    // SRC sources D.sourced1 ($100k) and D.sourcedOld ($80k); both have sales_source dsc rows.
    // SRC owns nothing. With no date filter: 100000 + 80000 = 180000 total.
    // D.sourcedUnsigned, D.sourcedLost, D.sourcedTest, D.sourcedOnHold must be excluded.
    const gate = await computeRepEarnedFloorGate(tdb, SRC, { from: null, to: null });
    expect(Number(gate.qualifyingRevenue)).toBe(180000);
    // floor is 50000; 180000 >= 50000 -> met
    expect(gate.floor).toBeCloseTo(50000, 2);
    expect(gate.met).toBe(true);
  });

  it("source leg respects the period date window", async () => {
    // RANGE = 2026: D.sourced1 ($100k, signed 2026-04-01) in -> 100000
    // D.sourcedOld ($80k, signed 2025-11-01) out -> excluded
    const gate2026 = await computeRepEarnedFloorGate(tdb, SRC, RANGE);
    expect(Number(gate2026.qualifyingRevenue)).toBe(100000);
    // 2025 range: only D.sourcedOld ($80k) -> 80000
    const gate2025 = await computeRepEarnedFloorGate(tdb, SRC, { from: "2025-01-01", to: "2025-12-31" });
    expect(Number(gate2025.qualifyingRevenue)).toBe(80000);
  });

  it("source leg excludes unsigned sourced deals (no contract_signed_at or contract_signed_date)", async () => {
    // D.sourcedUnsigned has no contract date -> must not contribute.
    // qualifying in 2026 window = only D.sourced1 = 100000 (not +50000 for unsigned)
    const gate = await computeRepEarnedFloorGate(tdb, SRC, RANGE);
    expect(Number(gate.qualifyingRevenue)).toBe(100000);
  });

  it("source leg excludes sourced deals in a lost stage", async () => {
    // D.sourcedLost ($50k signed, stage=lost) must not appear in SRC's qualifying.
    const gate = await computeRepEarnedFloorGate(tdb, SRC, RANGE);
    expect(Number(gate.qualifyingRevenue)).toBe(100000); // only D.sourced1
  });

  it("source leg excludes sourced test-data deals", async () => {
    // D.sourcedTest ($50k, is_test_data=true) must not appear in SRC's qualifying.
    const gate = await computeRepEarnedFloorGate(tdb, SRC, RANGE);
    expect(Number(gate.qualifyingRevenue)).toBe(100000);
  });

  it("source leg excludes sourced on-hold deals (reportable predicate)", async () => {
    // D.sourcedOnHold ($50k, on_hold=true) is excluded by aliasedActiveDealCountFilterSql.
    const gate = await computeRepEarnedFloorGate(tdb, SRC, RANGE);
    expect(Number(gate.qualifyingRevenue)).toBe(100000);
  });

  it("a deal owned by SVC does NOT credit SRC just because SRC is not the owner", async () => {
    // D.svcOwned has no sales_source_user_id -> SRC gets nothing from it.
    // SRC's qualifying (no date filter) = D.sourced1 ($100k) + D.sourcedOld ($80k) = 180000
    const gate = await computeRepEarnedFloorGate(tdb, SRC, { from: null, to: null });
    expect(Number(gate.qualifyingRevenue)).toBe(180000);
  });

  it("owner-only rep (SVC) gets the owner-leg qualifying but NOT the source credit (no double-count)", async () => {
    // SVC OWNS: D.sourced1 ($100k), D.sourcedUnsigned (unsigned -> excluded), D.sourcedLost (lost -> excl),
    // D.sourcedTest (test -> excl), D.sourcedOnHold (on_hold -> excl), D.svcOwned ($75k), D.sourcedOld ($80k).
    // Only signed+non-lost+non-test+non-hold deals count for SVC's owner leg (2026 range):
    //   D.sourced1: $100k, D.svcOwned: $75k -> total 175000
    //   D.sourcedOld: signed 2025 -> outside 2026 range
    const gate = await computeRepEarnedFloorGate(tdb, SVC, RANGE);
    expect(Number(gate.qualifyingRevenue)).toBeCloseTo(175000, 2);
  });

  it("owner-only rep with no sourced deals is unaffected by the new source leg (regression guard)", async () => {
    // OTHER owns nothing and sources nothing -> qualifying = 0; floor = 0 -> met
    const gate = await computeRepEarnedFloorGate(tdb, OTHER, RANGE);
    expect(Number(gate.qualifyingRevenue)).toBeCloseTo(0, 2);
    expect(gate.met).toBe(true); // floor 0, always met
  });

  it("below-floor: source rep without enough sourced revenue is still gated", async () => {
    // With the 2026 range SRC has $100k qualifying vs floor $50k -> met.
    // With no deals at all: floor = 50000, qualifying = 0 -> not met.
    // Simulate by using a future window where no sourced deals exist.
    const gate = await computeRepEarnedFloorGate(tdb, SRC, { from: "2030-01-01", to: "2030-12-31" });
    expect(Number(gate.qualifyingRevenue)).toBe(0);
    expect(gate.floor).toBeCloseTo(50000, 2);
    expect(gate.met).toBe(false);
  });

  it("P3: solo source rep without a sales_source dsc row gets 0 source credit (phantom-credit fix)", async () => {
    // D.soloSourced: sales_source_user_id = SOLO, signed 2027, $120k — but NO dsc row was minted
    // (SOLO has no rate config / calculateCommissionForDeal skipped the source cut).
    // Old SQL (d.sales_source_user_id = repId) would credit $120k here; new dsc-based SQL credits 0.
    // SOLO also owns nothing, so qualifying = 0 and floor 10000 is not met.
    const gate = await computeRepEarnedFloorGate(tdb, SOLO, { from: null, to: null });
    expect(Number(gate.qualifyingRevenue)).toBe(0);
    expect(gate.floor).toBeCloseTo(10000, 2);
    expect(gate.met).toBe(false);
  });

  it("P1: owner == source does NOT double-count — owner leg once, source leg 0 (no minted row)", async () => {
    // D.selfOwned: assigned_rep_id = SELF AND sales_source_user_id = SELF, $200k, signed 2027.
    // calculateCommissionForDeal skips the sales_source cut when owner == source (same rep), so no
    // sales_source dsc row exists. The new dsc-based source leg therefore contributes 0; the owner
    // leg (d.assigned_rep_id = SELF) counts the deal exactly once at $200k.
    // Old SQL would count $200k (owner leg) + $200k (source leg via d.sales_source_user_id = SELF)
    // = $400k, clearing the floor with doubled revenue.
    const gate2027 = await computeRepEarnedFloorGate(tdb, SELF, {
      from: "2027-01-01",
      to: "2027-12-31",
    });
    expect(Number(gate2027.qualifyingRevenue)).toBe(200000); // owner leg only, not $400k
    expect(gate2027.floor).toBeCloseTo(50000, 2);
    expect(gate2027.met).toBe(true); // 200000 >= 50000
  });

  it("P2: source rep REASSIGNED onto their own sourced deal is not double-counted", async () => {
    // D.reassigned: REASSIGN holds a sales_source dsc row ($70k) AND is now assigned_rep_id (reassigned
    // onto it). The owner leg counts it via ownership; the source leg excludes it via
    // `d.assigned_rep_id IS DISTINCT FROM repId`. Without that predicate qualifying would be $140k.
    const gate = await computeRepEarnedFloorGate(tdb, REASSIGN, { from: "2027-01-01", to: "2027-12-31" });
    expect(Number(gate.qualifyingRevenue)).toBe(70000); // owner leg once, source leg 0 — not $140k
  });
});
