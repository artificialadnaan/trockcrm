import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { computeRepEarnedFloorGate } from "../../../src/modules/commissions/floor-gate.js";
import { getRepCommissionDashboard } from "../../../src/modules/commissions/reporting-service.js";
import { getRepCommissionSummary } from "../../../src/modules/dashboard/service.js";

/**
 * REAL-SQL (PGlite) proof of the commission FLOOR GATE.
 *
 * The floor is a per-period GATE, not a deductible: below floor, earned commission is $0 everywhere
 * (per-deal AND totals AND manager override), but the deal breakdown stays visible at $0; at/above floor
 * the FULL earned amount is recognized from dollar one (no below-floor portion subtracted). Every surface
 * routes its floor check through the one helper (computeRepEarnedFloorGate), so this test exercises that
 * helper directly, then both aggregation engines, then proves they reconcile.
 *
 * qualifyingRevenue is the rep's OWNED signed book (assigned_rep_id, value awarded->bid->dd), NOT
 * commission-attributed (dsc) revenue — imported signed deals often carry no commission row, so dsc badly
 * undercounts an owner's book. REP_OWNED_NO_DSC locks that: it owns a signed deal with no dsc row.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const REP_ABOVE = U("a01"); // rate 0.10, floor 50000, owned book 100000 -> met, earned 10000
const REP_AT = U("a02"); // rate 0.10, floor 60000, owned book 60000 -> met (exact ==), earned 6000
const REP_BELOW = U("a03"); // rate 0.10, floor 80000, owned book 50000 -> NOT met, earned gates 5000 -> 0
const REP_ZEROFLOOR = U("a04"); // rate 0.10, floor 0, owned book 30000 -> met, earned 3000 (regression guard)
const REP_OWNED_NO_DSC = U("a05"); // floor 50000, owns a signed deal worth 90000 with NO dsc row -> met on owner book; earned 0
const REP_TESTDATA = U("a06"); // is_test_data=true, reports to MANAGER, meets floor + has earned -> MUST be excluded from override
const REP_INACTIVE = U("a07"); // is_active=false config w/ stale $1M floor -> treated as NO floor (not gated)
const REP_REASSIGNED = U("a08"); // holds the OWNER commission row on a deal now assigned to REP_NEWOWNER
const REP_NEWOWNER = U("a09"); // currently owns the reassigned deal, but earned nothing on it
const REP_OTHEROWNER = U("a10"); // currently owns a reassigned+edited deal (not asserted on directly)
const REP_REASSIGN_EDITED = U("a11"); // holds the owner row on a reassigned deal whose amount was later edited
const MANAGER = U("b01"); // own rate 0.10 floor 0, override 0.05 over REP_ABOVE + REP_BELOW (+ REP_TESTDATA, excluded)

const ST_OPEN = U("57001"); // 'opportunity' (signed earned rows live here in these fixtures)
const ST_LOST = U("57002"); // 'lost'

const D = {
  above1: U("d01"),
  above2: U("d02"),
  at1: U("d03"),
  below1: U("d04"),
  belowOnHold: U("d05"), // on-hold signed deal — MUST be excluded from gate + earned
  belowLost: U("d06"), // lost signed deal — MUST be excluded
  belowTest: U("d07"), // test-data signed deal — MUST be excluded
  zero1: U("d08"),
  manager1: U("d09"),
  ownedNoDsc: U("d10"),
  testRep1: U("d11"),
  inactive1: U("d12"),
  reassigned: U("d13"), // owned by REP_NEWOWNER now; owner commission row booked to REP_REASSIGNED
  reassignedNoDate: U("d14"), // same, but deal-level contract dates are NULL (legacy/reconciled row)
  reassignEdited: U("d15"), // reassigned away; deal amount EDITED post-reassignment ≠ booked owner-row value
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

const RANGE = { from: "2026-01-01", to: "2026-06-04" };

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

    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST_OPEN}', 'opportunity'), ('${ST_LOST}', 'lost');

    INSERT INTO users (id, display_name, is_active, role, reports_to, is_test_data) VALUES
      ('${REP_ABOVE}', 'Above', true, 'rep', '${MANAGER}', false),
      ('${REP_AT}', 'At', true, 'rep', NULL, false),
      ('${REP_BELOW}', 'Below', true, 'rep', '${MANAGER}', false),
      ('${REP_ZEROFLOOR}', 'ZeroFloor', true, 'rep', NULL, false),
      ('${REP_OWNED_NO_DSC}', 'OwnedNoDsc', true, 'rep', NULL, false),
      ('${REP_TESTDATA}', 'TestData', true, 'rep', '${MANAGER}', true),
      ('${REP_INACTIVE}', 'Inactive', true, 'rep', NULL, false),
      ('${REP_REASSIGNED}', 'Reassigned', true, 'rep', NULL, false),
      ('${REP_NEWOWNER}', 'NewOwner', true, 'rep', NULL, false),
      ('${REP_OTHEROWNER}', 'OtherOwner', true, 'rep', NULL, false),
      ('${REP_REASSIGN_EDITED}', 'ReassignEdited', true, 'rep', NULL, false),
      ('${MANAGER}', 'Manager', true, 'rep', NULL, false);

    INSERT INTO user_commission_settings (user_id, commission_rate, rolling_floor, override_rate) VALUES
      ('${REP_ABOVE}', 0.10, 50000, 0),
      ('${REP_REASSIGNED}', 0.10, 50000, 0),
      ('${REP_NEWOWNER}', 0.10, 0, 0),
      ('${REP_REASSIGN_EDITED}', 0.10, 60000, 0),
      ('${REP_AT}', 0.10, 60000, 0),
      ('${REP_BELOW}', 0.10, 80000, 0),
      ('${REP_ZEROFLOOR}', 0.10, 0, 0),
      ('${REP_OWNED_NO_DSC}', 0.10, 50000, 0),
      ('${REP_TESTDATA}', 0.10, 0, 0),
      ('${MANAGER}', 0.10, 0, 0.05);
    -- Inactive config carrying a stale $1M floor: must be treated as NO floor (not gated).
    INSERT INTO user_commission_settings (user_id, commission_rate, rolling_floor, override_rate, is_active) VALUES
      ('${REP_INACTIVE}', 0.10, 1000000, 0, false);

    -- REP_ABOVE: two signed deals, revenue 60000 + 40000 = 100000 >= floor 50000 -> met, earned 10000
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.above1}', 'A-1', 'Above 1', '${REP_ABOVE}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 60000, '2026-01-10T00:00:00Z'),
      ('${D.above2}', 'A-2', 'Above 2', '${REP_ABOVE}', '${ST_OPEN}', '2026-03-16T00:00:00Z', 40000, '2026-01-11T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.above1}', '${REP_ABOVE}', 'awarded', 60000, 0.10, 6000, '2026-03-15'),
      ('${D.above2}', '${REP_ABOVE}', 'awarded', 40000, 0.10, 4000, '2026-03-16');

    -- REP_AT: one signed deal, revenue 60000 == floor 60000 -> met (exact), earned 6000
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.at1}', 'AT-1', 'At 1', '${REP_AT}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 60000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.at1}', '${REP_AT}', 'awarded', 60000, 0.10, 6000, '2026-03-15');

    -- REP_BELOW: one VALID signed deal revenue 50000 < floor 80000 -> NOT met; earned raw 5000 must gate to 0.
    -- Plus on-hold / lost / test-data signed deals that MUST be excluded from BOTH the gate basis and earned
    -- (if counted, on-hold's 100000 alone would push the rep over the floor — proving the exclusion matters).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, on_hold, is_test_data, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.below1}', 'B-1', 'Below valid', '${REP_BELOW}', '${ST_OPEN}', false, false, '2026-03-15T00:00:00Z', 50000, '2026-01-10T00:00:00Z'),
      ('${D.belowOnHold}', 'B-2', 'Below on-hold', '${REP_BELOW}', '${ST_OPEN}', true, false, '2026-03-15T00:00:00Z', 100000, '2026-01-10T00:00:00Z'),
      ('${D.belowLost}', 'B-3', 'Below lost', '${REP_BELOW}', '${ST_LOST}', false, false, '2026-03-15T00:00:00Z', 100000, '2026-01-10T00:00:00Z'),
      ('${D.belowTest}', 'B-4', 'Below test', '${REP_BELOW}', '${ST_OPEN}', false, true, '2026-03-15T00:00:00Z', 100000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.below1}', '${REP_BELOW}', 'awarded', 50000, 0.10, 5000, '2026-03-15'),
      ('${D.belowOnHold}', '${REP_BELOW}', 'awarded', 100000, 0.10, 10000, '2026-03-15'),
      ('${D.belowLost}', '${REP_BELOW}', 'awarded', 100000, 0.10, 10000, '2026-03-15'),
      ('${D.belowTest}', '${REP_BELOW}', 'awarded', 100000, 0.10, 10000, '2026-03-15');

    -- REP_ZEROFLOOR: floor 0 -> always met (regression guard), earned 3000
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.zero1}', 'Z-1', 'Zero 1', '${REP_ZEROFLOOR}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 30000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.zero1}', '${REP_ZEROFLOOR}', 'awarded', 30000, 0.10, 3000, '2026-03-15');

    -- MANAGER: own signed deal revenue 20000, floor 0 -> earned 2000
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.manager1}', 'M-1', 'Manager 1', '${MANAGER}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 20000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.manager1}', '${MANAGER}', 'awarded', 20000, 0.10, 2000, '2026-03-15');

    -- REP_OWNED_NO_DSC: OWNS a signed deal worth 90000, but it has NO deal_signed_commissions row (the
    -- HubSpot-imported / Colby pattern). Owner-book qualifyingRevenue = 90000 >= floor 50000 -> met; but
    -- earnedCommission = 0 (nothing attributed). Under the OLD dsc basis qualifyingRevenue would be 0.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.ownedNoDsc}', 'O-1', 'Owned no dsc', '${REP_OWNED_NO_DSC}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 90000, '2026-01-10T00:00:00Z');

    -- REP_TESTDATA (flagged test/duplicate account) reports to MANAGER, meets floor 0, has earned 5000 on a
    -- REAL (non-test) deal. The override roster MUST exclude this user, so it contributes $0 to MANAGER's
    -- override (otherwise override would be (10000 + 5000) * 0.05 = 750 instead of 500).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.testRep1}', 'T-1', 'Test rep deal', '${REP_TESTDATA}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 50000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.testRep1}', '${REP_TESTDATA}', 'awarded', 50000, 0.10, 5000, '2026-03-15');

    -- REP_INACTIVE: tiny owned book ($10k) far under the stale $1M floor, with $1k earned. Because the
    -- config is inactive, the floor is treated as 0 -> met -> earned is NOT gated.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.inactive1}', 'I-1', 'Inactive rep deal', '${REP_INACTIVE}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 10000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
      ('${D.inactive1}', '${REP_INACTIVE}', 'awarded', 10000, 0.10, 1000, '2026-03-15');

    -- REASSIGNMENT: deal worth 90000 is CURRENTLY owned by REP_NEWOWNER, but the OWNER commission row
    -- was booked to REP_REASSIGNED (the original rep who signed it). The original rep keeps the earned
    -- commission, so its value must still count toward REP_REASSIGNED's floor (qualifying ↔ earned).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.reassigned}', 'R-1', 'Reassigned deal', '${REP_NEWOWNER}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 90000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.reassigned}', '${REP_REASSIGNED}', 'awarded', 90000, 0.10, 9000, 'owner', '2026-03-15');

    -- Same reassignment, but the deal's contract_signed_at/date are BOTH NULL (a legacy/reconciled owner
    -- row). Its only signing date is the dsc snapshot (contract_signed_date_at_signing). It earns 5000 via
    -- the earned-side date fallback, so its 50000 value MUST also count toward REP_REASSIGNED's qualifying
    -- via the SAME fallback — otherwise qualifying and earned stay inconsistent for this row.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, awarded_amount, created_at) VALUES
      ('${D.reassignedNoDate}', 'R-2', 'Reassigned no date', '${REP_NEWOWNER}', '${ST_OPEN}', 50000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.reassignedNoDate}', '${REP_REASSIGNED}', 'awarded', 50000, 0.10, 5000, 'owner', '2026-03-20');

    -- REASSIGNED + EDITED: a deal REP_REASSIGN_EDITED signed (owner row booked at 40000 -> earned 4000) was
    -- reassigned to REP_OTHEROWNER, and a director LATER edited the deal's awarded_amount up to 250000. The
    -- original rep's floor must credit the BOOKED 40000 (matching their earned), NOT the mutated 250000 — so
    -- the deal value can't spuriously release their floor. Booked 40000 < floor 60000 -> still held.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.reassignEdited}', 'RE-1', 'Reassigned then edited', '${REP_OTHEROWNER}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 250000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.reassignEdited}', '${REP_REASSIGN_EDITED}', 'awarded', 40000, 0.10, 4000, 'owner', '2026-03-15');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("computeRepEarnedFloorGate (the single floor check)", () => {
  it("above floor: met; qualifyingRevenue = owned book, earnedCommission = dsc attribution", async () => {
    const gate = await computeRepEarnedFloorGate(tdb, REP_ABOVE, RANGE);
    expect(gate.qualifyingRevenue).toBeCloseTo(100000, 2);
    expect(gate.earnedCommission).toBeCloseTo(10000, 2);
    expect(gate.floor).toBeCloseTo(50000, 2);
    expect(gate.met).toBe(true);
  });

  it("exactly at floor: met (>= passes on exact equality)", async () => {
    const gate = await computeRepEarnedFloorGate(tdb, REP_AT, RANGE);
    expect(gate.qualifyingRevenue).toBeCloseTo(60000, 2);
    expect(gate.floor).toBeCloseTo(60000, 2);
    expect(gate.met).toBe(true);
  });

  it("below floor: NOT met; on-hold/lost/test deals are excluded from the owned-book basis", async () => {
    const gate = await computeRepEarnedFloorGate(tdb, REP_BELOW, RANGE);
    // Only the single valid owned deal counts (50000), NOT the on-hold/lost/test 100000 rows.
    expect(gate.qualifyingRevenue).toBeCloseTo(50000, 2);
    expect(gate.earnedCommission).toBeCloseTo(5000, 2);
    expect(gate.floor).toBeCloseTo(80000, 2);
    expect(gate.met).toBe(false);
  });

  it("qualifyingRevenue is the OWNED book, not dsc attribution (signed deal with no commission row still counts)", async () => {
    const gate = await computeRepEarnedFloorGate(tdb, REP_OWNED_NO_DSC, RANGE);
    // Owns a signed $90k deal with NO dsc row. Owner-basis => 90000 (a dsc basis would give 0).
    expect(gate.qualifyingRevenue).toBeCloseTo(90000, 2);
    expect(gate.earnedCommission).toBeCloseTo(0, 2); // nothing attributed -> nothing to release
    expect(gate.floor).toBeCloseTo(50000, 2);
    expect(gate.met).toBe(true); // met on the owned book despite $0 attributed commission
  });

  it("floor 0: always met", async () => {
    const gate = await computeRepEarnedFloorGate(tdb, REP_ZEROFLOOR, RANGE);
    expect(gate.met).toBe(true);
    expect(gate.earnedCommission).toBeCloseTo(3000, 2);
  });

  it("inactive config: stale non-zero floor is ignored (treated as no floor)", async () => {
    const gate = await computeRepEarnedFloorGate(tdb, REP_INACTIVE, RANGE);
    expect(gate.floor).toBeCloseTo(0, 2); // stale $1M floor on an inactive config is NOT returned
    expect(gate.qualifyingRevenue).toBeCloseTo(10000, 2);
    expect(gate.earnedCommission).toBeCloseTo(1000, 2);
    expect(gate.met).toBe(true); // not gated despite owned book << stale floor
  });

  it("respects the period window (both sides of the comparison use the same window)", async () => {
    const gate = await computeRepEarnedFloorGate(tdb, REP_ABOVE, { from: "2027-01-01", to: "2027-12-31" });
    expect(gate.qualifyingRevenue).toBeCloseTo(0, 2);
    expect(gate.earnedCommission).toBeCloseTo(0, 2);
    expect(gate.met).toBe(false); // 0 >= 50000 is false
  });

  it("reassigned-away deals (incl. null-deal-date legacy rows): qualifyingRevenue reconciles with earned", async () => {
    // Two $90k + $50k deals now owned by REP_NEWOWNER, but REP_REASSIGNED holds the owner commission rows
    // and keeps the earned commission — so BOTH values must count toward REP_REASSIGNED's floor. The second
    // deal has NULL deal-level contract dates, so the gate must use the dsc snapshot date (the same fallback
    // the earned side uses) on the qualifying side too — else its 50000 earns but never qualifies.
    const gate = await computeRepEarnedFloorGate(tdb, REP_REASSIGNED, RANGE);
    expect(gate.qualifyingRevenue).toBeCloseTo(140000, 2);
    expect(gate.earnedCommission).toBeCloseTo(14000, 2);
    expect(gate.floor).toBeCloseTo(50000, 2);
    expect(gate.met).toBe(true);
  });

  it("REP_NEWOWNER (current owner of a reassigned deal) still counts it in qualifyingRevenue (no regression)", async () => {
    // The current owner keeps counting deals they own, even when someone else holds the commission row.
    const gate = await computeRepEarnedFloorGate(tdb, REP_NEWOWNER, RANGE);
    expect(gate.qualifyingRevenue).toBeCloseTo(90000, 2);
    expect(gate.earnedCommission).toBeCloseTo(0, 2); // earned nothing on it (no dsc row for this rep)
  });

  it("reassigned-away: qualifying uses the BOOKED owner-row value, not a later edit to the deal amount", async () => {
    // The deal was reassigned to another owner and its awarded_amount later edited to 250000, but
    // REP_REASSIGN_EDITED's owner commission row booked 40000. Qualifying must credit the booked 40000
    // (matching the earned 4000), so the mutated deal value can't release the rep's floor. The OLD code
    // (reading d.awarded_amount on the owner-row leg) would credit 250000 and wrongly report met=true.
    const gate = await computeRepEarnedFloorGate(tdb, REP_REASSIGN_EDITED, RANGE);
    expect(gate.qualifyingRevenue).toBeCloseTo(40000, 2); // booked source value, NOT the edited 250000
    expect(gate.earnedCommission).toBeCloseTo(4000, 2);
    expect(gate.floor).toBeCloseTo(60000, 2);
    expect(gate.met).toBe(false); // 40000 < 60000 — not spuriously released by the 250000 deal amount
  });
});

describe("Engine A — getRepCommissionDashboard reflects the gate", () => {
  it("below floor: page total AND every per-deal earned amount are $0, breakdown still visible", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_BELOW, ...RANGE });
    expect(dash.summary.earned).toBeCloseTo(0, 2);
    const earnedRows = dash.deals.filter((d) => d.isEarned);
    expect(earnedRows.length).toBeGreaterThan(0); // breakdown NOT empty
    for (const row of earnedRows) expect(row.commission).toBeCloseTo(0, 2);
    // "Earned" stage total also zeroed
    const wonStage = dash.stageTotals.find((s) => s.stageKey === "won");
    expect(wonStage?.commission ?? 0).toBeCloseTo(0, 2);
  });

  it("exactly at floor: full earned, no deduction of the below-floor portion", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_AT, ...RANGE });
    expect(dash.summary.earned).toBeCloseTo(6000, 2);
  });

  it("above floor: full earned including the below-floor portion", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_ABOVE, ...RANGE });
    expect(dash.summary.earned).toBeCloseTo(10000, 2); // entire 100000 * 0.10, nothing subtracted
  });

  it("floor 0: unchanged (regression guard)", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_ZEROFLOOR, ...RANGE });
    expect(dash.summary.earned).toBeCloseTo(3000, 2);
  });
});

describe("Engine B — getRepCommissionSummary reflects the gate + override", () => {
  it("below floor: direct + total earned are $0, breakdown still listed at $0", async () => {
    const { summary, deals } = await getRepCommissionSummary(tdb, REP_BELOW, RANGE.from, RANGE.to);
    expect(summary.directEarnedCommission).toBeCloseTo(0, 2);
    expect(summary.totalEarnedCommission).toBeCloseTo(0, 2);
    // The gross earned is WITHHELD (not lost): heldEarnedCommission carries it so surfaces can show
    // "$5,000 held" instead of a misleading $0.
    expect(summary.heldEarnedCommission).toBeCloseTo(5000, 2);
    expect(deals.length).toBeGreaterThan(0); // breakdown NOT empty
    for (const d of deals) expect(d.earnedCommission).toBeCloseTo(0, 2);
    // floorRemaining reports the remaining hurdle (80000 - 50000)
    expect(summary.floorRemaining).toBeCloseTo(30000, 2);
  });

  it("exactly at floor: full earned, no deduction", async () => {
    const { summary } = await getRepCommissionSummary(tdb, REP_AT, RANGE.from, RANGE.to);
    expect(summary.directEarnedCommission).toBeCloseTo(6000, 2);
    expect(summary.floorRemaining).toBeCloseTo(0, 2);
  });

  it("above floor: full earned incl. below-floor portion", async () => {
    const { summary } = await getRepCommissionSummary(tdb, REP_ABOVE, RANGE.from, RANGE.to);
    expect(summary.directEarnedCommission).toBeCloseTo(10000, 2);
  });

  it("floor 0: unchanged (regression guard)", async () => {
    const { summary } = await getRepCommissionSummary(tdb, REP_ZEROFLOOR, RANGE.from, RANGE.to);
    expect(summary.directEarnedCommission).toBeCloseTo(3000, 2);
  });

  it("manager override gates per report and excludes below-floor + test-data reports", async () => {
    const { summary } = await getRepCommissionSummary(tdb, MANAGER, RANGE.from, RANGE.to);
    // Reports: REP_ABOVE (met, earned 10000) included; REP_BELOW (not met) excluded; REP_TESTDATA
    // (test account, met, earned 5000) excluded from the roster. override = 10000 * 0.05 = 500 — not 750
    // (REP_TESTDATA's 5000 excluded) and not 750 incl. REP_BELOW's gated 5000.
    expect(summary.overrideEarnedCommission).toBeCloseTo(500, 2);
    // Manager's own earned (floor 0) 2000 + override 500 = 2500
    expect(summary.directEarnedCommission).toBeCloseTo(2000, 2);
    expect(summary.totalEarnedCommission).toBeCloseTo(2500, 2);
  });
});

describe("Engine A and Engine B reconcile on earned for the same rep/period", () => {
  it.each([
    ["above floor", REP_ABOVE],
    ["at floor", REP_AT],
    ["below floor", REP_BELOW],
    ["floor 0", REP_ZEROFLOOR],
  ])("%s: dashboard.summary.earned === summary.directEarnedCommission", async (_label, repId) => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: repId, ...RANGE });
    const { summary } = await getRepCommissionSummary(tdb, repId, RANGE.from, RANGE.to);
    expect(dash.summary.earned).toBeCloseTo(summary.directEarnedCommission, 2);
  });
});
