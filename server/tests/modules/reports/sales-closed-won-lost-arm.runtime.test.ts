import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getClosedWonRevenueReport, type SalesReportFilters } from "../../../src/modules/reports/sales-tier1-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for Wave-1 PR-E: the Closed Won win-rate DENOMINATOR (lost count) windows on
 * the canonical lost date (lost_at), not the reseed-contaminated `COALESCE(actual_close_date,
 * stage_entered_at)`. The Won numerator already uses won_closed_date; this aligns the Lost arm so the
 * win rate compares deals that reached an outcome in the same period on each side's canonical date.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const LOST = LOST_STAGE_SLUGS[0];
const ST = { won: U("57001"), lost: U("57002") };
const REP = U("a01");
const D = { won: U("d01"), lostByLostAt: U("d02") };
const FILTERS: SalesReportFilters = {
  dateFrom: "2026-02-01",
  dateTo: "2026-02-28",
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
      won_closed_date date, actual_close_date date, lost_at timestamptz, stage_entered_at timestamptz,
      contract_signed_at timestamptz, updated_at timestamptz,
      region_classification text, property_city text, property_state text, office_code text, workflow_route text,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST.won}','${WON}'), ('${ST.lost}','${LOST}');
    -- Won in Feb (numerator).
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, won_closed_date, awarded_amount) VALUES
      ('${D.won}','Won Feb','${ST.won}','${REP}','2026-02-10', 100000);
    -- Lost in Feb by lost_at (2026-02-15), but actual_close_date (2025-11) and stage_entered_at (2025-10)
    -- are OUTSIDE the window. Old lost arm (COALESCE(actual_close_date, stage_entered_at)) would place it
    -- in Nov -> NOT counted -> win rate 100%. New lost arm (lost_at) counts it -> win rate 50%.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, lost_at, actual_close_date, stage_entered_at, bid_estimate) VALUES
      ('${D.lostByLostAt}','Lost Feb','${ST.lost}','${REP}','2026-02-15T00:00:00Z','2025-11-01','2025-10-01T00:00:00Z', 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Closed Won win-rate denominator windows lost on canonical lost_at (PR-E)", () => {
  it("counts a deal lost in-period by lost_at even when actual_close_date/stage_entered are out of window", async () => {
    const report = await getClosedWonRevenueReport(tdb, FILTERS, "lost-arm-test");
    expect(report.kpis.wonDealCount).toBe(1);
    // 1 won + 1 lost (by lost_at) -> 50%. Old contaminated lost arm would give 100% (lost not counted).
    expect(report.kpis.winRate).toBeCloseTo(50, 1);
  });
});
