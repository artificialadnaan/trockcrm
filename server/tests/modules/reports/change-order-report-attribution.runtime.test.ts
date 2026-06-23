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
 * REAL-SQL (PGlite) reconciliation proof for change orders under the #657 CHILD-DEAL model — AFTER the
 * #650 deal_change_orders fold was removed (PR2). A change order is now its own Won child deal carrying the
 * CO's value (awarded_amount) at the CO's date (won_closed_date), inheriting the parent's
 * company/project_type/rep. So a CO is attributed by the SAME canonical won_closed_date axis as any Won
 * deal, in the parent's dimension bucket — no separate signed_date fold.
 *
 * THE DISJOINT-SUM INVARIANT still holds, now on a SINGLE axis (won_closed_date): a parent's base win and
 * its CO children are distinct Won deals, each counted once by its own won_closed_date. Proven by
 * partitioning a parent + its CO children across two non-overlapping year windows: 2025 + 2026 == combined.
 *
 * Reports isolated by window (Market Mix=2025/2026, Customer Concentration=2030, Executive Trends=2034)
 * under a NON-UTC session (Asia/Tokyo) so the date-typed period bounds are exercised.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const LOST_SLUG = LOST_STAGE_SLUGS[0];
const ST = { won: U("57001"), open: U("57002"), lost: U("57003") };
const REP = U("a01");
const D = { w2025: U("d2025"), w2026: U("d2026"), whold: U("d8011"), wout: U("d4044") }; // Market Mix parents
const CCD = { co: U("cab01"), open: U("dab01"), won: U("dab02") }; // Customer Concentration
const ETD = { co: U("cab02"), won: U("dab03") }; // Executive Trends
// CO child deals (real deals now), one per former deal_change_orders row.
const CO = { c01: U("c0001"), c02: U("c0002"), c04: U("c0004"), cc1: U("c0cc1"), cc2: U("c0cc2"), et1: U("c0e11"), et2: U("c0e22") };

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
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false, expected_close_date date,
      is_change_order boolean NOT NULL DEFAULT false, parent_deal_id uuid,
      project_type text, property_city text, property_state text,
      won_closed_date date, actual_close_date date, lost_at timestamptz, last_activity_at timestamptz,
      updated_at timestamptz, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal, display_order) VALUES
      ('${ST.won}','${WON_SLUG}','Won', true, 90),
      ('${ST.lost}','${LOST_SLUG}','Lost', true, 95),
      ('${ST.open}','opportunity','Opportunity', false, 30);
    INSERT INTO companies (id, name, industry) VALUES ('${CCD.co}','Acme','Roofing'), ('${ETD.co}','Globex','Roofing');

    -- ===== MARKET MIX (2025/2026) — single-axis (won_closed_date) partition =====
    -- W2025: WON 2025. W2026: WON 2026. WHOLD: WON 2026 but ON HOLD → base zeroed (Steel = 0). WOUT: WON 2026.
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type, on_hold, won_closed_date, created_at, updated_at, awarded_amount) VALUES
      ('${D.w2025}','${REP}','${ST.won}','Roofing', false, '2025-06-01','2025-05-01T00:00:00Z','2025-06-01T00:00:00Z', 100000),
      ('${D.w2026}','${REP}','${ST.won}','Roofing', false, '2026-05-01','2026-04-01T00:00:00Z','2026-05-01T00:00:00Z', 50000),
      ('${D.whold}','${REP}','${ST.won}','Steel',   true,  '2026-02-01','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z', 999999),
      ('${D.wout}', '${REP}','${ST.won}','Roofing', false, '2026-08-01','2026-07-01T00:00:00Z','2026-08-01T00:00:00Z', 70000);
    -- CO CHILD deals: Won, won_closed_date = the CO's date, awarded = the CO amount, project_type + rep
    -- inherited. c01 (on W2025) is won 2026 → lands in 2026. c04 (on WOUT) is won 2025 → lands in 2025.
    INSERT INTO deals (id, assigned_rep_id, stage_id, project_type, is_change_order, parent_deal_id, won_closed_date, created_at, updated_at, awarded_amount) VALUES
      ('${CO.c01}','${REP}','${ST.won}','Roofing', true, '${D.w2025}', '2026-03-01','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z', 25000),
      ('${CO.c02}','${REP}','${ST.won}','Roofing', true, '${D.w2026}', '2026-07-01','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z', 5000),
      ('${CO.c04}','${REP}','${ST.won}','Roofing', true, '${D.wout}',  '2025-01-01','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z', 12345);

    -- ===== CUSTOMER CONCENTRATION (2030) =====
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, project_type, won_closed_date, created_at, awarded_amount, bid_estimate) VALUES
      ('${CCD.open}','${CCD.co}','${REP}','${ST.open}','Roofing', NULL, '2030-02-01T00:00:00Z', NULL, 80000),
      ('${CCD.won}', '${CCD.co}','${REP}','${ST.won}', 'Roofing', '2030-05-01', '2030-04-01T00:00:00Z', 120000, NULL);
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, project_type, is_change_order, parent_deal_id, won_closed_date, created_at, awarded_amount) VALUES
      ('${CO.cc1}','${CCD.co}','${REP}','${ST.won}','Roofing', true, '${CCD.won}', '2030-06-01','2030-06-01T00:00:00Z', 5000),   -- won 2030 → in lifetime
      ('${CO.cc2}','${CCD.co}','${REP}','${ST.won}','Roofing', true, '${CCD.won}', '2029-06-01','2029-06-01T00:00:00Z', 99999);  -- won 2029 → excluded from 2030

    -- ===== EXECUTIVE TRENDS (2034) =====
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, project_type, won_closed_date, created_at, awarded_amount) VALUES
      ('${ETD.won}','${ETD.co}','${REP}','${ST.won}','Roofing','2034-03-01','2034-02-01T00:00:00Z', 300000);
    INSERT INTO deals (id, company_id, assigned_rep_id, stage_id, project_type, is_change_order, parent_deal_id, won_closed_date, created_at, awarded_amount) VALUES
      ('${CO.et1}','${ETD.co}','${REP}','${ST.won}','Roofing', true, '${ETD.won}', '2034-04-01','2034-04-01T00:00:00Z', 40000),   -- won 2034 → in Won Revenue KPI
      ('${CO.et2}','${ETD.co}','${REP}','${ST.won}','Roofing', true, '${ETD.won}', '2031-04-01','2031-04-01T00:00:00Z', 88888);   -- won 2031 → outside → excluded
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

const roofing = (mix: Array<{ name: string; wonValue: number }>) =>
  mix.find((m) => m.name === "Roofing")?.wonValue ?? 0;

describe("Market Mix counts CO child deals in Won value by won_closed_date (single-axis disjoint sum)", () => {
  it("2026: base + CO children (by won_closed_date), on-hold parent base excluded", async () => {
    const report = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    // Roofing 2026 = base W2026 (50000) + base WOUT (70000) + CO child c01 (25000, won 2026 on the 2025-won
    //              parent) + CO child c02 (5000). WOUT's CO child c04 is won 2025 → excluded here.
    expect(roofing(report.verticalMix)).toBeCloseTo(150000, 2);
    // Steel = WHOLD only, on hold → base zeroed → 0 (no CO child on it).
    const steel = report.verticalMix.find((m) => m.name === "Steel");
    expect(steel?.wonValue ?? 0).toBeCloseTo(0, 2);
    expect(report.kpis.totalWonValue).toBeCloseTo(150000, 2);
  });

  it("2025: base W2025 (100000) + CO child c04 (12345, won 2025 on a 2026-won parent)", async () => {
    const report = await getMarketMixReport(tdb, { from: "2025-01-01", to: "2025-12-31" });
    expect(roofing(report.verticalMix)).toBeCloseTo(112345, 2);
  });

  it("disjoint partition: 2025 + 2026 == combined window, every dollar counted exactly once", async () => {
    const y2025 = await getMarketMixReport(tdb, { from: "2025-01-01", to: "2025-12-31" });
    const y2026 = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const both = await getMarketMixReport(tdb, { from: "2025-01-01", to: "2026-12-31" });
    // base 100000+50000+70000 = 220000 ; CO children 25000+5000+12345 = 42345 (WHOLD base on-hold excluded) → 262345.
    expect(roofing(both.verticalMix)).toBeCloseTo(262345, 2);
    expect(roofing(y2025.verticalMix) + roofing(y2026.verticalMix)).toBeCloseTo(roofing(both.verticalMix), 2);
  });

  it("quarterly Won-by-vertical buckets CO children by their won_closed_date quarter, reconciling to the KPI total", async () => {
    const report = await getMarketMixReport(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const quarterlyTotal = report.quarterlyWonByVertical.reduce((s, r) => s + r.wonValue, 0);
    expect(quarterlyTotal).toBeCloseTo(report.kpis.totalWonValue, 2);
    // Q1 2026 carries CO child c01 (won 2026-03-01) = 25000 on Roofing — its 2025-won parent's base is NOT
    // in 2026, proving CO children land in their own won quarter.
    const q1Roofing = report.quarterlyWonByVertical.find((r) => r.quarter === "2026 Q1" && r.vertical === "Roofing");
    expect(q1Roofing?.wonValue ?? 0).toBeCloseTo(25000, 2);
  });
});

describe("Customer Concentration counts CO child deals in a customer's won lifetime (by won_closed_date)", () => {
  it("totalWonLifetime = base + CO children won-in-period; a CO child won outside is excluded", async () => {
    const report = await getCustomerConcentrationReport(tdb, { from: "2030-01-01", to: "2030-12-31" });
    const acme = report.topCustomers.find((c) => c.companyId === CCD.co);
    expect(acme).toBeDefined();
    // base 120000 (won 2030) + CO child cc1 5000 (won 2030). CO child cc2 99999 (won 2029) excluded.
    expect(acme?.totalWonLifetime).toBeCloseTo(125000, 2);
  });
});

describe("Executive Trends counts CO child deals in the Won Revenue KPI (by won_closed_date)", () => {
  it("Won Revenue = base + CO children won-in-period; a CO child won outside is excluded", async () => {
    const report = await getExecutiveTrendsReport(tdb, { from: "2034-01-01", to: "2034-12-31" });
    const wonRevenue = report.kpis.find((k) => k.label === "Won Revenue");
    // base 300000 (won 2034) + CO child et1 40000 (won 2034). CO child et2 88888 (won 2031) excluded.
    expect(wonRevenue?.value).toBeCloseTo(340000, 2);
  });
});
