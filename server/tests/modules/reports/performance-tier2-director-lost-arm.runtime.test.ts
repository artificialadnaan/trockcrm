import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getDirectorScorecard } from "../../../src/modules/reports/performance-tier2-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for Wave-1 PR-F (Tier-2 Lost-unification): the Director Scorecard win-rate
 * DENOMINATOR (won + lost) windows the LOST cohort on the canonical deals.lost_at, not the reseed-
 * contaminated COALESCE(contract_signed_at, actual_close_date, updated_at). The WON numerator already
 * windows on the canonical won_closed_date (Wave-0); this aligns the LOST arm so the rate compares
 * deals that reached an outcome in the SAME period on each side's canonical date.
 *
 * Direct extension of #648 (which fixed the identical contaminated denominator in Tier-1
 * getClosedWonRevenueReport). Mirrors sales-closed-won-lost-arm.runtime.test.ts for Tier-2.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON = WON_STAGE_SLUGS[0];
const LOST = LOST_STAGE_SLUGS[0];
const OPEN = "opportunity";
const OFF = U("0ff1");
const REP = U("a01");
const ST = { won: U("57001"), lost: U("57002"), open: U("57003") };
const D = { won: U("d01"), lostByLostAt: U("d02"), open: U("d03") };
const FILTERS = { dateFrom: "2026-02-01", dateTo: "2026-02-28", office: undefined, ownerIds: [], ownerNames: [] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE offices (id uuid PRIMARY KEY, name text, slug text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, office_id uuid, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false, expected_close_date date, bid_due_date timestamptz,
      on_hold_started_at timestamptz, on_hold_accumulated_seconds numeric, on_hold_accumulated_seconds_at_stage_entry numeric,
      won_closed_date date, lost_at timestamptz, contract_signed_at timestamptz, actual_close_date date, updated_at timestamptz,
      stage_entered_at timestamptz, bid_board_stage_slug text, bid_board_stage_entered_at timestamptz, workflow_route text,
      company_id uuid, last_activity_at timestamptz, office_code text,
      bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric, awarded_amount numeric
    );
    CREATE TABLE tasks (id uuid PRIMARY KEY, deal_id uuid, assigned_to uuid, status text, due_date date, is_test_data boolean NOT NULL DEFAULT false);
    CREATE TABLE activities (id uuid PRIMARY KEY, responsible_user_id uuid, occurred_at timestamptz);

    INSERT INTO offices (id, name, slug) VALUES ('${OFF}','Dallas','dallas');
    INSERT INTO users (id, display_name, office_id, is_active) VALUES ('${REP}','Alice','${OFF}', true);
    INSERT INTO pipeline_stage_config (id, slug, name) VALUES
      ('${ST.won}','${WON}','Won'), ('${ST.lost}','${LOST}','Lost'), ('${ST.open}','${OPEN}','Opportunity');

    -- Won in Feb by canonical won_closed_date (numerator).
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, won_closed_date, awarded_amount, stage_entered_at) VALUES
      ('${D.won}','Won Feb','${ST.won}','${REP}','${U("c01")}','2026-02-10', 100000, '2026-02-09T00:00:00Z');

    -- Lost in Feb by canonical lost_at (2026-02-15). contract_signed_at is NULL, actual_close_date (2025-11)
    -- and updated_at (2026-05) are OUTSIDE the window. Old contaminated lost arm
    -- (COALESCE(contract_signed_at, actual_close_date AT TIME ZONE 'UTC', updated_at)) resolves to Nov 2025
    -- -> NOT counted -> denominator = 1 -> win rate 100%. New lost arm (leads with lost_at) counts it
    -- -> denominator = 2 -> win rate 50%.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, lost_at, actual_close_date, updated_at, bid_estimate, stage_entered_at) VALUES
      ('${D.lostByLostAt}','Lost Feb','${ST.lost}','${REP}','${U("c02")}','2026-02-15T00:00:00Z','2025-11-01','2026-05-01T00:00:00Z', 50000, '2025-10-01T00:00:00Z');

    -- One open deal so the rep/office rows exist (and openDealCount is non-zero). Its dates are all out of
    -- window so it never enters the won_lost cohort; its slug is non-terminal so it is excluded from win rate.
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, updated_at, bid_estimate, stage_entered_at) VALUES
      ('${D.open}','Open Feb','${ST.open}','${REP}','${U("c03")}','2026-05-01T00:00:00Z', 25000, '2026-02-01T00:00:00Z');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Director Scorecard win-rate denominator windows lost on canonical lost_at (PR-F Tier-2)", () => {
  it("counts a deal lost in-period by lost_at even when contract_signed_at/actual_close_date/updated_at are out of window", async () => {
    const report = await getDirectorScorecard(tdb, FILTERS, "director-lost-arm-test");

    // KPI headline win rate: 1 won + 1 lost (by lost_at) -> 50%. Old contaminated lost arm windowed the
    // lost deal on Nov 2025 (out) -> only the won deal counted -> 100%.
    expect(report.kpis.winRate).toBeCloseTo(50, 1);

    // The same canonical-lost denominator flows to the rep and office breakdowns (they share buildWonDateSql).
    const alice = report.repPerformance.find((r) => r.repName === "Alice");
    expect(alice?.winRate).toBeCloseTo(50, 1);
    expect(alice?.wonThisPeriod).toBe(1);

    const dallas = report.officeComparison.find((o) => o.officeName === "Dallas");
    expect(dallas?.winRate).toBeCloseTo(50, 1);
  });
});
