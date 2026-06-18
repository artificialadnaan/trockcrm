import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getRepCommissionDashboard } from "../../../src/modules/commissions/reporting-service.js";
import {
  getRepCommissionSummary,
  getRepWonMissingContractDate,
} from "../../../src/modules/dashboard/service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for the Team-Commissions drill-down on the Director rep-detail page.
 *
 * The drill-down adds three things on top of the existing floor-gated engines, and every one of them
 * must RECONCILE BY CONSTRUCTION with the flat Team-Commissions list (which is Engine B,
 * getRepCommissionSummary) and the rep's own page (Engine A, getRepCommissionDashboard):
 *
 *   1. Owner vs estimator split — each contributing deal carries attributionRole, and
 *      Σ(owner cuts) + Σ(estimator cuts) === directEarnedCommission (no row dropped or double-counted).
 *   2. Floor progress — summary.qualifyingRevenue / floorMet surface the gate's owned-book basis.
 *   3. Won-but-missing-contract worklist — Won-family owned deals with no contract date (stuck commission).
 *
 * Plus rep-injection safety for "View as rep": getRepCommissionDashboard resolves repId ONLY for non-rep
 * callers, so a rep can never drill into another rep's data.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

const REP_MIX = U("c01"); // owns one deal (owner cut) AND estimates another (estimator cut). rate .10, floor 0.
const REP_OTHER = U("c02"); // owns the deal REP_MIX estimated.
const REP_WL = U("c03"); // worklist rep: Won-family deals, some missing a contract date.
const REP_NEG = U("c04"); // owns a +5000 deal AND a -1000 adjustment row -> direct 4000 (negative-row reconcile).
const REP_NETNEG = U("c05"); // +1000 and -3000 -> net direct -2000 (rows must still show; snapshot-skip probe).
const DIRECTOR = U("c0d"); // a director — used to prove repId drill-down works for non-rep callers.

const ST_OPEN = U("58001"); // 'opportunity' (signed earned rows)
const ST_LOST = U("58002"); // 'lost'
const ST_WON = U("58003"); // a real Won-family slug (WON_STAGE_SLUGS[0])

const D = {
  mixOwn: U("e01"), // REP_MIX owns + has owner dsc 5000
  mixEst: U("e02"), // REP_OTHER owns; REP_MIX has estimator dsc 1000
  otherOwn: U("e03"), // REP_OTHER owner dsc 3000 on mixEst (their own deal)
  wlMissing: U("e04"), // REP_WL Won, NO contract date -> worklist
  wlMissing2: U("e05"), // REP_WL Won, NO contract date -> worklist
  wlSigned: U("e06"), // REP_WL Won, HAS contract date -> excluded
  wlLost: U("e07"), // REP_WL Lost, no contract date -> excluded (not Won-family)
  wlTest: U("e08"), // REP_WL Won, no contract date, is_test_data -> excluded
  negOwn: U("e09"), // REP_NEG owner dsc +5000
  negAdj: U("e10"), // REP_NEG owner dsc -1000 (a clawback/adjustment)
  wlChangeOrder: U("e11"), // REP_WL Won change order, no contract date -> excluded (CHANGE_ORDER_FIELD_LOCKED)
  wlOnHold: U("e14"), // REP_WL Won, on_hold, no contract date -> excluded (setting a date releases no commission)
  netNegOwn: U("e12"), // REP_NETNEG owner dsc +1000
  netNegAdj: U("e13"), // REP_NETNEG owner dsc -3000 -> net direct -2000
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
      company_id uuid, property_id uuid, property_address text, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      won_closed_date date, expected_close_date date, stage_entered_at timestamptz, updated_at timestamptz,
      created_at timestamptz, awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric,
      dd_estimate numeric, change_order_total numeric
    );
    CREATE TABLE deal_signed_commissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, rep_user_id uuid,
      source_value_kind text, source_value_amount numeric, applied_rate numeric, amount numeric,
      attribution_role text NOT NULL DEFAULT 'owner', contract_signed_date_at_signing date
    );

    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('${ST_OPEN}', 'opportunity'), ('${ST_LOST}', 'lost'), ('${ST_WON}', '${WON_STAGE_SLUGS[0]}');

    INSERT INTO users (id, display_name, role) VALUES
      ('${REP_MIX}', 'Mix', 'rep'),
      ('${REP_OTHER}', 'Other', 'rep'),
      ('${REP_WL}', 'Worklist', 'rep'),
      ('${REP_NEG}', 'Neg', 'rep'),
      ('${REP_NETNEG}', 'NetNeg', 'rep'),
      ('${DIRECTOR}', 'Director', 'director');

    INSERT INTO user_commission_settings (user_id, commission_rate, rolling_floor, override_rate) VALUES
      ('${REP_MIX}', 0.10, 0, 0),
      ('${REP_OTHER}', 0.10, 0, 0),
      ('${REP_WL}', 0.10, 0, 0),
      ('${REP_NEG}', 0.10, 0, 0),
      ('${REP_NETNEG}', 0.10, 0, 0);

    -- REP_MIX owns mixOwn (owner cut 5000). signed in window.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.mixOwn}', 'MIX-1', 'Mix owned', '${REP_MIX}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 50000, '2026-01-10T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.mixOwn}', '${REP_MIX}', 50000, 0.10, 5000, 'owner', '2026-03-15');

    -- mixEst owned by REP_OTHER; REP_MIX is the estimator (estimator cut 1000), REP_OTHER owner cut 3000.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, estimator_user_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.mixEst}', 'MIX-2', 'Mix estimated', '${REP_OTHER}', '${REP_MIX}', '${ST_OPEN}', '2026-03-16T00:00:00Z', 30000, '2026-01-11T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.mixEst}', '${REP_OTHER}', 30000, 0.10, 3000, 'owner', '2026-03-16'),
      ('${D.mixEst}', '${REP_MIX}', 30000, 0.0333, 1000, 'estimator', '2026-03-16');

    -- REP_WL worklist fixtures.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, is_test_data, contract_signed_at, contract_signed_date, won_closed_date, awarded_amount, created_at) VALUES
      ('${D.wlMissing}', 'WL-1', 'WL missing A', '${REP_WL}', '${ST_WON}', false, NULL, NULL, '2026-04-01', 70000, '2026-02-01T00:00:00Z'),
      ('${D.wlMissing2}', 'WL-2', 'WL missing B', '${REP_WL}', '${ST_WON}', false, NULL, NULL, '2026-04-02', 40000, '2026-02-02T00:00:00Z'),
      ('${D.wlSigned}', 'WL-3', 'WL signed', '${REP_WL}', '${ST_WON}', false, '2026-04-03T00:00:00Z', NULL, '2026-04-03', 90000, '2026-02-03T00:00:00Z'),
      ('${D.wlLost}', 'WL-4', 'WL lost', '${REP_WL}', '${ST_LOST}', false, NULL, NULL, NULL, 90000, '2026-02-04T00:00:00Z'),
      ('${D.wlTest}', 'WL-5', 'WL test', '${REP_WL}', '${ST_WON}', true, NULL, NULL, '2026-04-05', 90000, '2026-02-05T00:00:00Z');
    -- REP_WL change order, Won-family, no contract date -> MUST be excluded (the contract-date PATCH rejects
    -- change orders with CHANGE_ORDER_FIELD_LOCKED, so it would be an unactionable stuck row).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, is_test_data, is_change_order, contract_signed_at, contract_signed_date, won_closed_date, awarded_amount, created_at) VALUES
      ('${D.wlChangeOrder}', 'WL-6', 'WL change order', '${REP_WL}', '${ST_WON}', false, true, NULL, NULL, '2026-04-06', 25000, '2026-02-06T00:00:00Z');
    -- On-hold Won deal missing a contract date: excluded because the commission queries filter on-hold, so
    -- setting a date here would clear the row without releasing any commission.
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, on_hold, contract_signed_at, contract_signed_date, won_closed_date, awarded_amount, created_at) VALUES
      ('${D.wlOnHold}', 'WL-7', 'WL on hold', '${REP_WL}', '${ST_WON}', true, NULL, NULL, '2026-04-07', 80000, '2026-02-07T00:00:00Z');

    -- REP_NEG: owner +5000 and a -1000 adjustment (clawback) -> direct = 4000. Proves the breakdown sum
    -- reconciles with directEarnedCommission even with a NEGATIVE row (which a >0 filter would drop).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.negOwn}', 'NEG-1', 'Neg owned', '${REP_NEG}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 50000, '2026-01-10T00:00:00Z'),
      ('${D.negAdj}', 'NEG-2', 'Neg adjustment', '${REP_NEG}', '${ST_OPEN}', '2026-03-16T00:00:00Z', 10000, '2026-01-11T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.negOwn}', '${REP_NEG}', 50000, 0.10, 5000, 'owner', '2026-03-15'),
      ('${D.negAdj}', '${REP_NEG}', 10000, -0.10, -1000, 'owner', '2026-03-16');

    -- REP_NETNEG: +1000 and -3000 -> NET direct -2000. The breakdown must STILL show both rows (not [])
    -- so Σ(rows) === directEarnedCommission == -2000 (the directEarnedCommission<=0 early-return is gone).
    INSERT INTO deals (id, deal_number, name, assigned_rep_id, stage_id, contract_signed_at, awarded_amount, created_at) VALUES
      ('${D.netNegOwn}', 'NN-1', 'NetNeg owned', '${REP_NETNEG}', '${ST_OPEN}', '2026-03-15T00:00:00Z', 10000, '2026-01-10T00:00:00Z'),
      ('${D.netNegAdj}', 'NN-2', 'NetNeg adjustment', '${REP_NETNEG}', '${ST_OPEN}', '2026-03-16T00:00:00Z', 30000, '2026-01-11T00:00:00Z');
    INSERT INTO deal_signed_commissions (deal_id, rep_user_id, source_value_amount, applied_rate, amount, attribution_role, contract_signed_date_at_signing) VALUES
      ('${D.netNegOwn}', '${REP_NETNEG}', 10000, 0.10, 1000, 'owner', '2026-03-15'),
      ('${D.netNegAdj}', '${REP_NETNEG}', 30000, -0.10, -3000, 'owner', '2026-03-16');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("owner/estimator split reconciles to directEarnedCommission (Engine B)", () => {
  it("each contributing deal carries attributionRole; owner + estimator cuts sum to direct", async () => {
    const { summary, deals } = await getRepCommissionSummary(tdb, REP_MIX, RANGE.from, RANGE.to);

    // Two contributing rows: one owner cut (5000), one estimator cut (1000).
    expect(deals).toHaveLength(2);
    const owner = deals.filter((d) => d.attributionRole === "owner");
    const estimator = deals.filter((d) => d.attributionRole === "estimator");
    expect(owner).toHaveLength(1);
    expect(estimator).toHaveLength(1);
    expect(owner[0]!.earnedCommission).toBeCloseTo(5000, 2);
    expect(estimator[0]!.earnedCommission).toBeCloseTo(1000, 2);

    const ownerSum = owner.reduce((s, d) => s + d.earnedCommission, 0);
    const estimatorSum = estimator.reduce((s, d) => s + d.earnedCommission, 0);
    // The load-bearing reconciliation: owner + estimator == direct (no row dropped/double-counted).
    expect(ownerSum + estimatorSum).toBeCloseTo(summary.directEarnedCommission, 2);
    expect(summary.directEarnedCommission).toBeCloseTo(6000, 2);
  });

  it("includes a NEGATIVE adjustment row so the breakdown sum still equals directEarnedCommission", async () => {
    const { summary, deals } = await getRepCommissionSummary(tdb, REP_NEG, RANGE.from, RANGE.to);
    // Both rows present (the -1000 is NOT dropped by a >0 filter).
    expect(deals).toHaveLength(2);
    const sum = deals.reduce((s, d) => s + d.earnedCommission, 0);
    expect(sum).toBeCloseTo(summary.directEarnedCommission, 2);
    expect(summary.directEarnedCommission).toBeCloseTo(4000, 2); // 5000 - 1000
  });

  it("NET-NEGATIVE direct: rows still render (no empty-on-<=0 early return), Σ === directEarnedCommission", async () => {
    const { summary, deals } = await getRepCommissionSummary(tdb, REP_NETNEG, RANGE.from, RANGE.to);
    // direct nets to -2000 (1000 - 3000); the breakdown must NOT collapse to [] — that would hide the
    // adjustment rows while Team Commissions shows the negative total.
    expect(deals).toHaveLength(2);
    const sum = deals.reduce((s, d) => s + d.earnedCommission, 0);
    expect(summary.directEarnedCommission).toBeCloseTo(-2000, 2);
    expect(sum).toBeCloseTo(summary.directEarnedCommission, 2);
  });

  it("floor progress: qualifyingRevenue is the OWNED book (excludes the estimated deal), floor met at 0", async () => {
    const { summary } = await getRepCommissionSummary(tdb, REP_MIX, RANGE.from, RANGE.to);
    // Owns only mixOwn (50000). The 30000 deal they merely ESTIMATED is owned by REP_OTHER -> excluded.
    expect(summary.qualifyingRevenue).toBeCloseTo(50000, 2);
    expect(summary.floorMet).toBe(true);
    expect(summary.totalEarnedCommission).toBeCloseTo(
      summary.directEarnedCommission + summary.overrideEarnedCommission,
      2
    );
  });
});

describe("three surfaces reconcile on the same window", () => {
  it("Engine A (rep's own page) earned === Engine B directEarnedCommission for the drill-down rep", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_MIX, ...RANGE });
    const { summary } = await getRepCommissionSummary(tdb, REP_MIX, RANGE.from, RANGE.to);
    // Engine A sums all dsc rows for the rep (owner + estimator) -> equals Engine B's direct.
    expect(dash.summary.earned).toBeCloseTo(summary.directEarnedCommission, 2);
    expect(dash.summary.earned).toBeCloseTo(6000, 2);
  });
});

describe("View-as-rep: getRepCommissionDashboard is rep-injection-safe", () => {
  it("a rep passing another repId still gets their OWN data (resolver pins reps to self)", async () => {
    // REP_MIX (a rep) tries to view REP_OTHER -> must resolve to REP_MIX (earned 6000), NOT REP_OTHER (3000).
    const dash = await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_MIX, repId: REP_OTHER, ...RANGE });
    expect(dash.summary.earned).toBeCloseTo(6000, 2);
  });

  it("a director CAN drill into a specific rep via repId (what the View-as-rep endpoint does)", async () => {
    const dash = await getRepCommissionDashboard(tdb, { role: "director", userId: DIRECTOR, repId: REP_OTHER, ...RANGE });
    // REP_OTHER's own earned: owner cut 3000 on their deal.
    expect(dash.summary.earned).toBeCloseTo(3000, 2);
  });
});

describe("Won-but-missing-contract worklist", () => {
  it("returns only Won-family owned deals with no contract date; excludes signed / lost / test / change-order / on-hold", async () => {
    const rows = await getRepWonMissingContractDate(tdb, REP_WL);
    const numbers = rows.map((r) => r.dealNumber).sort();
    // signed (WL-3), lost (WL-4), test (WL-5), change order (WL-6), AND on-hold (WL-7) are all excluded.
    // The change order would reject the contract-date PATCH (CHANGE_ORDER_FIELD_LOCKED); the on-hold deal
    // would clear from the worklist without releasing any commission (commission queries filter on-hold).
    expect(numbers).toEqual(["WL-1", "WL-2"]);
    expect(numbers).not.toContain("WL-6");
    expect(numbers).not.toContain("WL-7");
    // Highest value first (70000 before 40000), value resolved via the awarded-first chain.
    expect(rows[0]!.dealNumber).toBe("WL-1");
    expect(rows[0]!.value).toBeCloseTo(70000, 2);
    expect(rows[0]!.wonDate).toBe("2026-04-01");
  });

  it("a rep with no stuck Won deals returns an empty worklist", async () => {
    const rows = await getRepWonMissingContractDate(tdb, REP_MIX);
    expect(rows).toEqual([]);
  });
});

describe("View-as-rep is read-only: skipSnapshotRefresh does not mutate the rep's snapshots", () => {
  async function snapshotCount(repId: string): Promise<number> {
    const res = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commission_deal_snapshots WHERE rep_user_id = $1`,
      [repId]
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  it("skipSnapshotRefresh=true writes NO snapshot; the default path DOES (proves the opt-out works)", async () => {
    // REP_NETNEG has only been read via Engine B so far (which never writes snapshots) -> starts at 0.
    expect(await snapshotCount(REP_NETNEG)).toBe(0);

    // Director read-only preview: must not touch the rep's snapshots.
    await getRepCommissionDashboard(tdb, {
      role: "director",
      userId: DIRECTOR,
      repId: REP_NETNEG,
      skipSnapshotRefresh: true,
      ...RANGE,
    });
    expect(await snapshotCount(REP_NETNEG)).toBe(0);

    // The rep viewing their OWN page (default) still refreshes snapshots for the "since last update" delta.
    await getRepCommissionDashboard(tdb, { role: "rep", userId: REP_NETNEG, ...RANGE });
    expect(await snapshotCount(REP_NETNEG)).toBeGreaterThan(0);
  });
});
