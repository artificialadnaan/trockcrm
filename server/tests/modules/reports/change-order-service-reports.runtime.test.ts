import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getClosedWonSummary, getRevenueByProjectType } from "../../../src/modules/reports/service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof that change orders reconcile in the base service.ts won-date-cohort revenue
 * reports (Closed Won Summary, Revenue by Type) under the #657 CHILD-DEAL model — AFTER the #650
 * deal_change_orders fold was removed (PR2). A change order is now its own Won child deal: it carries the
 * CO's value as awarded_amount and the CO's date as won_closed_date, inheriting the parent's rep +
 * project_type. So a CO is counted by the SAME canonical Won path as any Won deal (by won_closed_date), in
 * the parent's rep/type bucket — no separate fold. The disjoint-sum invariant still holds by construction:
 * Σ byRep == Σ byType == totalWonValue, each dollar counted once.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const ST = { won: U("57001"), open: U("57002") };
const REP_A = U("a01");
const REP_B = U("a02");
const PT_R = U("70001"); // Roofing
const PT_P = U("70002"); // Plumbing
const PT_G = U("70003"); // Glazing — isolated 2040 window for the null-won-date-parent edge
const D = { a: U("d00a"), b: U("d00b"), nullwon: U("d00d"), unassigned: U("d00e") };
// CO child deals (real deals now), one per former deal_change_orders row.
const CO = { a1: U("c0a1"), a2: U("c0a2"), b1: U("c0b1"), nw1: U("c0d1"), un1: U("c0e1") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='Asia/Tokyo';`);
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
    CREATE TABLE project_type_config (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, assigned_rep_id uuid, stage_id uuid NOT NULL, project_type_id uuid,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      is_change_order boolean NOT NULL DEFAULT false, parent_deal_id uuid,
      won_closed_date date, actual_close_date date, updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice'), ('${REP_B}','Bob');
    INSERT INTO project_type_config (id, name) VALUES ('${PT_R}','Roofing'), ('${PT_P}','Plumbing'), ('${PT_G}','Glazing');
    INSERT INTO pipeline_stage_config (id, slug, is_terminal) VALUES ('${ST.won}','${WON_SLUG}', true), ('${ST.open}','opportunity', false);

    -- Parent deals.
    -- A: WON 2026 (Alice/Roofing) 100000.   B: WON 2025 (Bob/Plumbing) 50000.
    -- NULLWON: WON stage, NULL won_closed_date (Glazing) → excluded from every report (usable-won-date guard),
    --   but its CO child (its OWN won_closed_date 2040) still counts.
    -- UNASSIGNED: rep-less WON deal (2045) → base + its CO child reconcile into an 'Unassigned' byRep bucket.
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type_id, won_closed_date, created_at, awarded_amount) VALUES
      ('${D.a}','${REP_A}','${ST.won}','${PT_R}', '2026-06-01','2026-05-01T00:00:00Z', 100000),
      ('${D.b}','${REP_B}','${ST.won}','${PT_P}', '2025-06-01','2025-05-01T00:00:00Z', 50000),
      ('${D.nullwon}','${REP_A}','${ST.won}','${PT_G}', NULL, '2040-04-01T00:00:00Z', 60000),
      ('${D.unassigned}', NULL, '${ST.won}','${PT_R}', '2045-06-01','2045-05-01T00:00:00Z', 20000);
    -- CO CHILD deals: is_change_order, parent_deal_id, Won stage, won_closed_date = the CO's date,
    -- awarded_amount = the CO amount, rep + project_type inherited from the parent. Counted as Won deals.
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type_id, is_change_order, parent_deal_id, won_closed_date, created_at, awarded_amount) VALUES
      ('${CO.a1}','${REP_A}','${ST.won}','${PT_R}', true, '${D.a}', '2026-07-01','2026-07-01T00:00:00Z', 10000),
      ('${CO.a2}','${REP_A}','${ST.won}','${PT_R}', true, '${D.a}', '2025-01-01','2025-01-01T00:00:00Z', 5000),
      ('${CO.b1}','${REP_B}','${ST.won}','${PT_P}', true, '${D.b}', '2026-03-01','2026-03-01T00:00:00Z', 8000),
      ('${CO.nw1}','${REP_A}','${ST.won}','${PT_G}', true, '${D.nullwon}', '2040-05-01','2040-05-01T00:00:00Z', 4000),
      ('${CO.un1}', NULL, '${ST.won}','${PT_R}', true, '${D.unassigned}', '2045-07-01','2045-07-01T00:00:00Z', 3000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("getClosedWonSummary counts CO child deals by won_closed_date (in the parent's rep/type bucket)", () => {
  it("2026: per-rep + per-type include CO children; breakdowns reconcile to the total", async () => {
    const r = await getClosedWonSummary(tdb, { from: "2026-01-01", to: "2026-12-31" });
    // base A 100000 + CO children won in 2026 (A's a1 10000 + B's b1 8000; A's a2 won 2025 excluded) = 118000.
    expect(r.totalWonValue).toBeCloseTo(118000, 2);
    const alice = r.byRep.find((x) => x.repId === REP_A);
    const bob = r.byRep.find((x) => x.repId === REP_B);
    expect(alice?.totalValue).toBeCloseTo(110000, 2); // base 100000 + CO child 10000
    expect(bob?.totalValue).toBeCloseTo(8000, 2); // CO-child-only (base win was 2025)
    const roofing = r.byProjectType.find((x) => x.projectTypeName === "Roofing");
    const plumbing = r.byProjectType.find((x) => x.projectTypeName === "Plumbing");
    expect(roofing?.totalValue).toBeCloseTo(110000, 2);
    expect(plumbing?.totalValue).toBeCloseTo(8000, 2); // CO-child-only type
    // Breakdowns reconcile to the total (children are base Won deals, so this holds by construction).
    expect(r.byRep.reduce((s, x) => s + x.totalValue, 0)).toBeCloseTo(r.totalWonValue, 2);
    expect(r.byProjectType.reduce((s, x) => s + x.totalValue, 0)).toBeCloseTo(r.totalWonValue, 2);
  });

  it("rep-less won deals + their CO children reconcile into an 'Unassigned' byRep bucket (Σ byRep == total)", async () => {
    const s = await getClosedWonSummary(tdb, { from: "2045-01-01", to: "2045-12-31" });
    // The only 2045 activity is the rep-less deal: base 20000 + CO child 3000 = 23000.
    expect(s.totalWonValue).toBeCloseTo(23000, 2);
    const unassigned = s.byRep.find((x) => x.repName === "Unassigned");
    expect(unassigned?.totalValue).toBeCloseTo(23000, 2);
    expect(s.byRep.reduce((acc, x) => acc + x.totalValue, 0)).toBeCloseTo(s.totalWonValue, 2);
    expect(s.byProjectType.reduce((acc, x) => acc + x.totalValue, 0)).toBeCloseTo(s.totalWonValue, 2);
  });

  it("disjoint partition: 2025 + 2026 == combined window total, each dollar once", async () => {
    const y2025 = await getClosedWonSummary(tdb, { from: "2025-01-01", to: "2025-12-31" });
    const y2026 = await getClosedWonSummary(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const both = await getClosedWonSummary(tdb, { from: "2025-01-01", to: "2026-12-31" });
    // 2025: base B 50000 + CO child a2 5000 = 55000. Combined: base 150000 + CO children 23000 = 173000.
    expect(y2025.totalWonValue).toBeCloseTo(55000, 2);
    expect(both.totalWonValue).toBeCloseTo(173000, 2);
    expect(y2025.totalWonValue + y2026.totalWonValue).toBeCloseTo(both.totalWonValue, 2);
  });

  it("a voided CO (on_hold tombstone, is_active=false) drops from Won rollups — value AND count", async () => {
    // deleteDealChangeOrder tombstones a voided CO with on_hold=true (+ is_active=false). The on_hold-only
    // Won rollups must then exclude it from BOTH totalWonValue (on_hold → 0) and totalWonDeals (on_hold
    // filter). (on_hold here stands in for a tombstoned CO; the deal-side tombstone is proven in
    // change-order-child-deal.runtime.test.ts.)
    await pg.exec(
      `INSERT INTO deals (id, assigned_rep_id, stage_id, project_type_id, on_hold, won_closed_date, created_at, awarded_amount) VALUES
        ('${U("5a01")}','${REP_A}','${ST.won}','${PT_R}', false, '2050-06-01','2050-05-01T00:00:00Z', 4000),
        ('${U("5a02")}','${REP_A}','${ST.won}','${PT_R}', true,  '2050-06-01','2050-05-01T00:00:00Z', 7000)`
    );
    const s = await getClosedWonSummary(tdb, { from: "2050-01-01", to: "2050-12-31" });
    expect(s.totalWonValue).toBeCloseTo(4000, 2); // the voided 7000 is zeroed (on_hold)
    expect(s.totalWonDeals).toBe(1); // the voided deal is excluded from the count (on_hold predicate)
  });
});

describe("getRevenueByProjectType counts CO child deals in the parent's project type", () => {
  it("2026: Roofing = base + CO child; Plumbing = CO-child-only", async () => {
    const rows = await getRevenueByProjectType(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const roofing = rows.find((x) => x.projectTypeName === "Roofing");
    const plumbing = rows.find((x) => x.projectTypeName === "Plumbing");
    expect(roofing?.totalRevenue).toBeCloseTo(110000, 2); // base 100000 + CO child 10000
    expect(plumbing?.totalRevenue).toBeCloseTo(8000, 2); // CO-child-only
  });

  it("a CO child on a NULL-won-date parent still counts (by its OWN won_closed_date; parent base excluded)", async () => {
    // Glazing's parent has NO won date → its base 60000 is excluded everywhere; its CO CHILD has its own
    // won_closed_date (2040) so it counts in 2040.
    const rows = await getRevenueByProjectType(tdb, { from: "2040-01-01", to: "2040-12-31" });
    const glazing = rows.find((x) => x.projectTypeName === "Glazing");
    expect(glazing?.totalRevenue).toBeCloseTo(4000, 2);
    const summary = await getClosedWonSummary(tdb, { from: "2040-01-01", to: "2040-12-31" });
    expect(summary.totalWonValue).toBeCloseTo(4000, 2); // only the CO child; the null-won-date parent never lands
  });
});
