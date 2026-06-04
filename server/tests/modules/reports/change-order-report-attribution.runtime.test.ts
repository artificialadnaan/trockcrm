import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getMarketMixReport,
  getCustomerConcentrationReport,
  getExecutiveTrendsReport,
} from "../../../src/modules/reports/analytics-tier4-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) reconciliation proof for Change Orders Part 2 — additive signed-date attribution.
 *
 * THE DISJOINT-SUM INVARIANT (RED's fix-regardless money invariant): a deal's base Won value is
 * attributed to the period of its won_closed_date, and each change order's value is attributed to the
 * period of its OWN signed_date — two disjoint axes, summed exactly once. So for any period:
 *
 *     period Won value = SUM(base awarded by won_closed_date ∈ period)  ⊕  SUM(CO amount by signed_date ∈ period)
 *
 * with NO double-count (the base awarded_amount must NOT already include CO value). Proven below by
 * partitioning a deal + its COs across two non-overlapping year windows: 2025 + 2026 == combined.
 *
 * Three reports are isolated by window (Market Mix=2025/2026, Customer Concentration=2030, Executive
 * Trends=2034) so each report's date filter sees only its own seeded rows. Runs under a NON-UTC session
 * (Asia/Tokyo) so the canonical date-typed period bounds are exercised.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const LOST_SLUG = LOST_STAGE_SLUGS[0];
const ST = { won: U("57001"), open: U("57002"), lost: U("57003") };
const REP = U("a01");
const D = { w2025: U("d2025"), w2026: U("d2026"), whold: U("d8011"), wout: U("d4044") }; // Market Mix
const CCD = { co: U("cab01"), open: U("dab01"), won: U("dab02") }; // Customer Concentration
const ETD = { co: U("cab02"), won: U("dab03") }; // Executive Trends

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='Asia/Tokyo';`);
  await pg.exec(`
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, industry text, region text, last_activity_at timestamptz);
    CREATE TABLE properties (id uuid PRIMARY KEY, property_type text, type text, city text, state text);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false, display_order int);
    CREATE TABLE activities (deal_id uuid, occurred_at timestamptz);
    CREATE TABLE deal_stage_history (deal_id uuid, from_stage_id uuid, to_stage_id uuid, created_at timestamptz);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, company_id uuid, property_id uuid, region_id uuid, assigned_rep_id uuid, estimator_user_id uuid,
      stage_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      project_type text, property_city text, property_state text,
      won_closed_date date, actual_close_date date, lost_at timestamptz, last_activity_at timestamptz,
      updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric
    );
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY, deal_id uuid NOT NULL, signed_date date NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount > 0), description text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal, display_order) VALUES
      ('${ST.won}','${WON_SLUG}','Won', true, 90),
      ('${ST.lost}','${LOST_SLUG}','Lost', true, 95),
      ('${ST.open}','opportunity','Opportunity', false, 30);
    INSERT INTO companies (id, name, industry) VALUES ('${CCD.co}','Acme','Roofing'), ('${ETD.co}','Globex','Roofing');

    -- ===== MARKET MIX (2025/2026) — the disjoint-sum partition =====
    -- W2025: WON 2025 (base→2025), CO signed 2026 (→2026). W2026: WON 2026, CO signed 2026.
    -- WHOLD: WON 2026 but ON HOLD → base zeroed AND CO excluded. WOUT: WON 2026, CO signed 2025 (→2025).
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type, on_hold, won_closed_date, created_at, updated_at, awarded_amount) VALUES
      ('${D.w2025}','${REP}','${ST.won}','Roofing', false, '2025-06-01','2025-05-01T00:00:00Z','2025-06-01T00:00:00Z', 100000),
      ('${D.w2026}','${REP}','${ST.won}','Roofing', false, '2026-05-01','2026-04-01T00:00:00Z','2026-05-01T00:00:00Z', 50000),
      ('${D.whold}','${REP}','${ST.won}','Steel',   true,  '2026-02-01','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z', 999999),
      ('${D.wout}', '${REP}','${ST.won}','Roofing', false, '2026-08-01','2026-07-01T00:00:00Z','2026-08-01T00:00:00Z', 70000);
    INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES
      ('${U("c01")}','${D.w2025}','2026-03-01', 25000),
      ('${U("c02")}','${D.w2026}','2026-07-01', 5000),
      ('${U("c03")}','${D.whold}','2026-04-01', 88888),
      ('${U("c04")}','${D.wout}', '2025-01-01', 12345);

    -- ===== CUSTOMER CONCENTRATION (2030) =====
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, project_type, won_closed_date, created_at, awarded_amount, bid_estimate) VALUES
      ('${CCD.open}','${CCD.co}','${REP}','${ST.open}','Roofing', NULL, '2030-02-01T00:00:00Z', NULL, 80000),
      ('${CCD.won}', '${CCD.co}','${REP}','${ST.won}', 'Roofing', '2030-05-01', '2030-04-01T00:00:00Z', 120000, NULL);
    INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES
      ('${U("e0c1")}','${CCD.won}','2030-06-01', 5000),    -- signed in the 2030 window → folded into lifetime
      ('${U("e0c2")}','${CCD.won}','2029-06-01', 99999);   -- signed in 2029 → excluded from the 2030 window

    -- ===== EXECUTIVE TRENDS (2034) =====
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, project_type, won_closed_date, created_at, awarded_amount) VALUES
      ('${ETD.won}','${ETD.co}','${REP}','${ST.won}','Roofing','2034-03-01','2034-02-01T00:00:00Z', 300000);
    INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES
      ('${U("e0c3")}','${ETD.won}','2034-04-01', 40000),   -- signed in the 2034 window → folded into Won Revenue KPI
      ('${U("e0c4")}','${ETD.won}','2031-04-01', 88888);   -- signed in 2031 → outside current & previous → excluded
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

const roofing = (mix: Array<{ name: string; wonValue: number }>) =>
  mix.find((m) => m.name === "Roofing")?.wonValue ?? 0;

describe("Market Mix folds period-attributed change orders into Won value (disjoint-sum)", () => {
  it("2026: base by won_closed_date + COs by signed_date, on-hold excluded, CO signed outside is excluded", async () => {
    const report = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    // Roofing 2026 = base W2026 (50000) + base WOUT (70000) + CO c01 (25000, signed 2026 on the 2025-won deal)
    //              + CO c02 (5000). WOUT's CO c04 is signed 2025 → excluded here.
    expect(roofing(report.verticalMix)).toBeCloseTo(150000, 2);
    // Steel = WHOLD only, on hold → base zeroed AND CO c03 (88888) excluded → 0.
    const steel = report.verticalMix.find((m) => m.name === "Steel");
    expect(steel?.wonValue ?? 0).toBeCloseTo(0, 2);
    // KPI total reconciles to the folded dimension map.
    expect(report.kpis.totalWonValue).toBeCloseTo(150000, 2);
  });

  it("2025: base W2025 (100000) + CO c04 (12345, signed 2025 on a 2026-won deal)", async () => {
    const report = await getMarketMixReport(tdb, { from: "2025-01-01", to: "2025-12-31" });
    expect(roofing(report.verticalMix)).toBeCloseTo(112345, 2);
  });

  it("disjoint partition: 2025 + 2026 == combined window, every dollar counted exactly once", async () => {
    const y2025 = await getMarketMixReport(tdb, { from: "2025-01-01", to: "2025-12-31" });
    const y2026 = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const both = await getMarketMixReport(tdb, { from: "2025-01-01", to: "2026-12-31" });
    // base 100000+50000+70000 = 220000 ; COs 25000+5000+12345 = 42345 (c03 on-hold excluded) → 262345.
    expect(roofing(both.verticalMix)).toBeCloseTo(262345, 2);
    // The two non-overlapping windows partition the combined total exactly — no double-count, no gap.
    expect(roofing(y2025.verticalMix) + roofing(y2026.verticalMix)).toBeCloseTo(roofing(both.verticalMix), 2);
  });

  it("quarterly Won-by-vertical also folds COs by signed-date quarter and reconciles to the KPI total", async () => {
    const report = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const quarterlyTotal = report.quarterlyWonByVertical.reduce((s, r) => s + r.wonValue, 0);
    // Quarterly panel (base by won quarter + COs by signed quarter) sums to the same KPI total.
    expect(quarterlyTotal).toBeCloseTo(report.kpis.totalWonValue, 2);
    // Specifically Q1 2026 carries CO c01 (signed 2026-03-01) = 25000 on Roofing (its 2025-won parent's
    // base is NOT in 2026), proving COs land in their own signed quarter.
    const q1Roofing = report.quarterlyWonByVertical.find((r) => r.quarter === "2026 Q1" && r.vertical === "Roofing");
    expect(q1Roofing?.wonValue ?? 0).toBeCloseTo(25000, 2);
  });
});

describe("Customer Concentration folds change orders into a customer's won lifetime (by signed_date)", () => {
  it("totalWonLifetime = base won-in-period + COs signed-in-period; a CO signed outside is excluded", async () => {
    const report = await getCustomerConcentrationReport(tdb, { from: "2030-01-01", to: "2030-12-31" });
    const acme = report.topCustomers.find((c) => c.companyId === CCD.co);
    expect(acme).toBeDefined();
    // base 120000 (won 2030) + CO e0c1 5000 (signed 2030). CO e0c2 99999 (signed 2029) excluded.
    expect(acme?.totalWonLifetime).toBeCloseTo(125000, 2);
  });
});

describe("Executive Trends folds change orders into the Won Revenue KPI (by signed_date)", () => {
  it("Won Revenue = base won-in-period + COs signed-in-period; a CO signed outside is excluded", async () => {
    const report = await getExecutiveTrendsReport(tdb, { from: "2034-01-01", to: "2034-12-31" });
    const wonRevenue = report.kpis.find((k) => k.label === "Won Revenue");
    // base 300000 (won 2034) + CO e0c3 40000 (signed 2034). CO e0c4 88888 (signed 2031) excluded.
    expect(wonRevenue?.value).toBeCloseTo(340000, 2);
  });
});
