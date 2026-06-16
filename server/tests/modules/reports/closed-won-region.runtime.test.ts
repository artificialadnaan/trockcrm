import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getClosedWonRevenueReport, type SalesReportFilters } from "../../../src/modules/reports/sales-tier1-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof that Closed Won Revenue rolls up by REGION (one row per region) instead of by
 * office, AND that the region key is CASE-FOLDED / whitespace- & comma-normalized so spelling variants of
 * the same place collapse into ONE bar/row.
 *
 * The old byOffice grouped on `o.id, o.name, d.office_code`, so two same-region deals carrying DIFFERENT
 * office_code values landed in SEPARATE office rows. byRegion groups on a single region expression
 * (region_classification, then property city/state). But before this fix the city/state key was only
 * TRIMmed, not case-folded, so "dallas, TX" / "Dallas, TX" / "DAllas, TX" became THREE buckets (live prod
 * showed Dallas split 3 ways: 103/7/2), plus double-commas ("Austin,, TX") and lowercase singletons
 * ("coppell, TX"). The fix INITCAPs the city, UPPERs the state, collapses internal whitespace, and rebuilds
 * the label from cleaned comma components so spellings collapse to one canonical bucket.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const ST = U("57001");
const REP = U("a01");
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
      won_closed_date date, actual_close_date date, lost_at timestamptz, contract_signed_at timestamptz, stage_entered_at timestamptz, updated_at timestamptz,
      region_classification text, property_city text, property_state text, office_code text, workflow_route text,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST}','${WON}');

    -- DALLAS via property city/state with THREE different spellings + casings + different office_code.
    -- Pre-fix: three separate buckets ("dallas, TX" / "Dallas, tx" / "DAllas, Tx"). Post-fix: ONE "Dallas, TX".
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, property_city, property_state, office_code, awarded_amount) VALUES
      ('${U("d01")}','Dallas A','${ST}','${REP}','2026-03-10','dallas','TX','Dallas Office', 300000),
      ('${U("d02")}','Dallas B','${ST}','${REP}','2026-03-12','Dallas','tx','Fort Worth Office', 100000),
      ('${U("d03")}','Dallas C','${ST}','${REP}','2026-03-13','DAllas','Tx','Dallas Office', 50000);

    -- HOUSTON via region_classification (precedence) with messy internal whitespace + spaced comma:
    -- "  Houston ,  TX " must normalize to "Houston, TX".
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, region_classification, awarded_amount) VALUES
      ('${U("d04")}','Houston','${ST}','${REP}','2026-03-15','  Houston ,  TX ', 200000);

    -- AUSTIN with a stray comma in the city ("Austin,") -> pre-fix yields the double-comma "Austin,, TX";
    -- post-fix the comma is cleaned out of the component -> "Austin, TX".
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, property_city, property_state, awarded_amount) VALUES
      ('${U("d05")}','Austin','${ST}','${REP}','2026-03-18','Austin,','TX', 80000);

    -- COPPELL lowercase singleton -> "Coppell, TX".
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, property_city, property_state, awarded_amount) VALUES
      ('${U("d06")}','Coppell','${ST}','${REP}','2026-03-19','coppell','tx', 25000);

    -- BLANK city (empty string, not NULL) + state -> must yield "GA", not ", GA".
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, property_city, property_state, awarded_amount) VALUES
      ('${U("d07")}','Blank city','${ST}','${REP}','2026-03-22','','GA', 25000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Closed Won Revenue rolls up by region with a case-folded, comma-normalized key", () => {
  it("collapses spelling/casing/whitespace/comma variants into one bucket per region", async () => {
    const report = await getClosedWonRevenueReport(tdb, FILTERS, "region-test");
    const byRegion = report.byRegion;
    expect(byRegion).toBeDefined();

    // Five regions: Dallas (3 spellings combined), Houston, Austin, Coppell, GA (blank-city fallback).
    expect(byRegion.length).toBe(5);

    const dallas = byRegion.filter((r) => r.regionName === "Dallas, TX");
    expect(dallas.length).toBe(1); // ONE combined row, not three
    expect(dallas[0].wonDeals).toBe(3);
    expect(dallas[0].totalRevenue).toBeCloseTo(450000, 2);

    expect(byRegion.find((r) => r.regionName === "Houston, TX")?.totalRevenue).toBeCloseTo(200000, 2);
    expect(byRegion.find((r) => r.regionName === "Austin, TX")?.totalRevenue).toBeCloseTo(80000, 2);
    expect(byRegion.find((r) => r.regionName === "Coppell, TX")?.totalRevenue).toBeCloseTo(25000, 2);
    expect(byRegion.find((r) => r.regionName === "GA")?.totalRevenue).toBeCloseTo(25000, 2);

    // No label is left malformed: trimmed, no leading/trailing comma, no double comma.
    expect(
      byRegion.every(
        (r) =>
          r.regionName === r.regionName.trim() &&
          !r.regionName.startsWith(",") &&
          !r.regionName.endsWith(",") &&
          !r.regionName.includes(",,"),
      ),
    ).toBe(true);

    // Shares sum to ~100% of booked revenue.
    const totalPct = byRegion.reduce((acc, r) => acc + r.percentOfTotal, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });
});
