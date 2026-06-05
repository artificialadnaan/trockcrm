import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getClosedWonSummary, getRevenueByProjectType } from "../../../src/modules/reports/service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) reconciliation proof for Change Orders Part 2 on the base service.ts won-date-cohort
 * revenue reports (Closed Won Summary, Revenue by Type). Same disjoint-sum invariant as the analytics
 * tier: base awarded by won_closed_date ⊕ CO amount by signed_date, each dollar once, on-hold excluded.
 * Also proves CO-only breakdown rows (a rep/type with COs signed in-period but no base win in-period)
 * keep each breakdown a complete sum (Σ byRep == Σ byType == totalWonValue).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const ST = { won: U("57001"), open: U("57002") };
const REP_A = U("a01");
const REP_B = U("a02");
const PT_R = U("70001"); // Roofing
const PT_P = U("70002"); // Plumbing
const PT_G = U("70003"); // Glazing — isolated 2040 window for the null-won-date edge
const D = { a: U("d00a"), b: U("d00b"), c: U("d00c"), nullwon: U("d00d"), unassigned: U("d00e") };

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
      won_closed_date date, actual_close_date date, updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY, deal_id uuid NOT NULL, signed_date date NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount > 0), description text, created_at timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice'), ('${REP_B}','Bob');
    INSERT INTO project_type_config (id, name) VALUES ('${PT_R}','Roofing'), ('${PT_P}','Plumbing'), ('${PT_G}','Glazing');
    INSERT INTO pipeline_stage_config (id, slug, is_terminal) VALUES ('${ST.won}','${WON_SLUG}', true), ('${ST.open}','opportunity', false);

    -- A: WON 2026 (Alice/Roofing) base 100000; CO 10000 signed 2026 (in window) + CO 5000 signed 2025 (out).
    -- B: WON 2025 (Bob/Plumbing) base 50000 (out of 2026 window); CO 8000 signed 2026 → CO-only in 2026.
    -- C: WON 2026 but ON HOLD (Alice/Roofing) base 999999 → zeroed; CO 88888 signed 2026 → excluded.
    -- NULLWON: WON stage but NULL won_closed_date (Glazing/2040) → base is excluded from every report
    -- (usable-won-date guard), but its CO (signed 2040) must still count: a CO stands on its own
    -- signed_date, independent of whether the parent has a usable won date.
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type_id, on_hold, won_closed_date, created_at, awarded_amount) VALUES
      ('${D.a}','${REP_A}','${ST.won}','${PT_R}', false, '2026-06-01','2026-05-01T00:00:00Z', 100000),
      ('${D.b}','${REP_B}','${ST.won}','${PT_P}', false, '2025-06-01','2025-05-01T00:00:00Z', 50000),
      ('${D.c}','${REP_A}','${ST.won}','${PT_R}', true,  '2026-04-01','2026-03-01T00:00:00Z', 999999),
      ('${D.nullwon}','${REP_A}','${ST.won}','${PT_G}', false, NULL, '2040-04-01T00:00:00Z', 60000),
      -- UNASSIGNED: rep-less WON deal (2045) → base + CO must reconcile into an 'Unassigned' byRep bucket.
      ('${D.unassigned}', NULL, '${ST.won}','${PT_R}', false, '2045-06-01','2045-05-01T00:00:00Z', 20000);
    INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES
      ('${U("a0c1")}','${D.a}','2026-07-01', 10000),
      ('${U("a0c2")}','${D.a}','2025-01-01', 5000),
      ('${U("b0c1")}','${D.b}','2026-03-01', 8000),
      ('${U("c0c1")}','${D.c}','2026-05-01', 88888),
      ('${U("d0c1")}','${D.nullwon}','2040-05-01', 4000),
      ('${U("e0c1")}','${D.unassigned}','2045-07-01', 3000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("getClosedWonSummary folds change orders by signed_date (disjoint, reconciling breakdowns)", () => {
  it("2026: total + per-rep + per-type fold COs; on-hold excluded; CO-only rep/type appear", async () => {
    const r = await getClosedWonSummary(tdb, { from: "2026-01-01", to: "2026-12-31" });
    // base A 100000 (C on-hold → 0) + COs (A 10000 + B 8000; A's 2025 CO and C's CO excluded) = 118000.
    expect(r.totalWonValue).toBeCloseTo(118000, 2);
    const alice = r.byRep.find((x) => x.repId === REP_A);
    const bob = r.byRep.find((x) => x.repId === REP_B);
    expect(alice?.totalValue).toBeCloseTo(110000, 2); // base 100000 + CO 10000
    expect(bob?.totalValue).toBeCloseTo(8000, 2); // CO-only (base win was 2025)
    const roofing = r.byProjectType.find((x) => x.projectTypeName === "Roofing");
    const plumbing = r.byProjectType.find((x) => x.projectTypeName === "Plumbing");
    expect(roofing?.totalValue).toBeCloseTo(110000, 2);
    expect(plumbing?.totalValue).toBeCloseTo(8000, 2); // CO-only type
    // Breakdowns reconcile to the total (complete disjoint sum).
    expect(r.byRep.reduce((s, x) => s + x.totalValue, 0)).toBeCloseTo(r.totalWonValue, 2);
    expect(r.byProjectType.reduce((s, x) => s + x.totalValue, 0)).toBeCloseTo(r.totalWonValue, 2);
  });

  it("rep-less won deals + their COs reconcile into an 'Unassigned' byRep bucket (Σ byRep == total)", async () => {
    const s = await getClosedWonSummary(tdb, { from: "2045-01-01", to: "2045-12-31" });
    // The only 2045 activity is the rep-less deal: base 20000 + CO 3000 = 23000.
    expect(s.totalWonValue).toBeCloseTo(23000, 2);
    const unassigned = s.byRep.find((x) => x.repName === "Unassigned");
    expect(unassigned?.totalValue).toBeCloseTo(23000, 2);
    // The invariant CodeRabbit flagged: the breakdown must still sum to the total with an unassigned parent.
    expect(s.byRep.reduce((acc, x) => acc + x.totalValue, 0)).toBeCloseTo(s.totalWonValue, 2);
    expect(s.byProjectType.reduce((acc, x) => acc + x.totalValue, 0)).toBeCloseTo(s.totalWonValue, 2);
  });

  it("disjoint partition: 2025 + 2026 == combined window total, each dollar once", async () => {
    const y2025 = await getClosedWonSummary(tdb, { from: "2025-01-01", to: "2025-12-31" });
    const y2026 = await getClosedWonSummary(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const both = await getClosedWonSummary(tdb, { from: "2025-01-01", to: "2026-12-31" });
    // 2025: base B 50000 + CO a0c2 5000 = 55000. Combined: base 150000 + COs 23000 = 173000.
    expect(y2025.totalWonValue).toBeCloseTo(55000, 2);
    expect(both.totalWonValue).toBeCloseTo(173000, 2);
    expect(y2025.totalWonValue + y2026.totalWonValue).toBeCloseTo(both.totalWonValue, 2);
  });
});

describe("getRevenueByProjectType folds change orders by signed_date", () => {
  it("2026: Roofing = base + CO; Plumbing = CO-only; on-hold excluded", async () => {
    const rows = await getRevenueByProjectType(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const roofing = rows.find((x) => x.projectTypeName === "Roofing");
    const plumbing = rows.find((x) => x.projectTypeName === "Plumbing");
    expect(roofing?.totalRevenue).toBeCloseTo(110000, 2); // base 100000 + CO 10000
    expect(plumbing?.totalRevenue).toBeCloseTo(8000, 2); // CO-only
  });

  it("a CO on a WON deal with NULL won_closed_date still counts by signed_date (base excluded, CO not)", async () => {
    // Glazing's parent has NO won date → base 60000 is excluded everywhere; its CO (signed 2040) counts.
    const rows = await getRevenueByProjectType(tdb, { from: "2040-01-01", to: "2040-12-31" });
    const glazing = rows.find((x) => x.projectTypeName === "Glazing");
    expect(glazing?.totalRevenue).toBeCloseTo(4000, 2);
    const summary = await getClosedWonSummary(tdb, { from: "2040-01-01", to: "2040-12-31" });
    expect(summary.totalWonValue).toBeCloseTo(4000, 2); // only the CO; the null-won-date base never lands
  });
});
