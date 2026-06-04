import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getClosedWonRevenueReport, type SalesReportFilters } from "../../../src/modules/reports/sales-tier1-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof that Closed Won Revenue rolls up by REGION (one row per region) instead of by
 * office. The old byOffice grouped on `o.id, o.name, d.office_code`, so two same-region deals carrying
 * DIFFERENT office_code values landed in SEPARATE office rows. byRegion groups on a single region
 * expression (region_classification, then property city/state), so those deals COMBINE into one row
 * regardless of office_code, and a deal with no region_classification falls back to city/state.
 * (Adnaan: "Dallas office is just one — combine; by region is more useful.")
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const ST = U("57001");
const REP = U("a01");
const D = { d1: U("d01"), d2: U("d02"), d3: U("d03"), d4: U("d04") };
const FILTERS: SalesReportFilters = {
  dateFrom: "2026-03-01",
  dateTo: "2026-03-31",
  ownerIds: [],
  ownerNames: [],
  ownerEmails: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, email text, office_id uuid);
    CREATE TABLE offices (id uuid PRIMARY KEY, name text, slug text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date, actual_close_date date, contract_signed_at timestamptz, stage_entered_at timestamptz, updated_at timestamptz,
      region_classification text, property_city text, property_state text, office_code text, workflow_route text,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST}','${WON}');
    -- Two same-region (Dallas, TX) deals with DIFFERENT office_code -> the old byOffice would split them
    -- into two rows; byRegion combines them into one.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, region_classification, office_code, awarded_amount) VALUES
      ('${D.d1}','Dallas A','${ST}','${REP}','2026-03-10','Dallas, TX','Dallas Office', 300000),
      ('${D.d2}','Dallas B','${ST}','${REP}','2026-03-12','Dallas, TX','Fort Worth Office', 100000),
      ('${D.d3}','Houston','${ST}','${REP}','2026-03-15','Houston, TX','Houston Office', 200000);
    -- NULL region_classification -> falls back to property city/state.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, property_city, property_state, awarded_amount) VALUES
      ('${D.d4}','Austin','${ST}','${REP}','2026-03-20','Austin','TX', 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Closed Won Revenue rolls up by region (combining what byOffice fragmented)", () => {
  it("groups won revenue into one row per region", async () => {
    const report = await getClosedWonRevenueReport(tdb, FILTERS, "region-test");
    const byRegion = report.byRegion;
    expect(byRegion).toBeDefined();
    // Three regions: Dallas (combined), Houston, Austin (city/state fallback).
    expect(byRegion.length).toBe(3);
    const dallas = byRegion.filter((r) => r.regionName === "Dallas, TX");
    expect(dallas.length).toBe(1); // ONE combined row, not two
    expect(dallas[0].wonDeals).toBe(2);
    expect(dallas[0].totalRevenue).toBeCloseTo(400000, 2);
    expect(byRegion.find((r) => r.regionName === "Houston, TX")?.totalRevenue).toBeCloseTo(200000, 2);
    expect(byRegion.find((r) => r.regionName === "Austin, TX")?.totalRevenue).toBeCloseTo(50000, 2);
    // Shares sum to ~100% of booked revenue (650k).
    const totalPct = byRegion.reduce((acc, r) => acc + r.percentOfTotal, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });
});
