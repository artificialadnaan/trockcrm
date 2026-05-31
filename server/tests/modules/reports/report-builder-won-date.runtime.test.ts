import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { runReportBuilder } from "../../../src/modules/reports/report-builder-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for report-builder Decision 1: a custom report whose stage filter is
 * Won-only forces its period axis (range + month bucket) onto the canonical won_closed_date,
 * overriding the user's selected date field — so Won count/value are windowed by the won date, not
 * created_at/updated_at. A report with no Won-only stage filter keeps the user's chosen axis.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const REP = U("a01");
const ST = { won: U("57001"), open: U("57002") };
const D = { wonMar: U("11001"), wonFeb: U("11002") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, assigned_rep_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, name) VALUES ('${ST.won}','${WON_SLUG}','Won'), ('${ST.open}','opportunity','Opportunity');

    -- WON in March, CREATED in Jan
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, created_at, awarded_amount) VALUES
      ('${D.wonMar}','${REP}','${ST.won}','2026-03-15','2026-01-05T00:00:00Z', 100000),
      -- WON in Feb, CREATED in March
      ('${D.wonFeb}','${REP}','${ST.won}','2026-02-10','2026-03-20T00:00:00Z', 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

const baseInput = {
  dimensions: ["month"],
  measures: ["total_value"],
  dateField: "created_at" as const,
  role: "admin" as const,
  userId: "admin-1",
};

describe("report-builder Decision 1: Won-stage cohort forces the won_closed_date axis", () => {
  it("Won-only stage filter windows + buckets by won_closed_date, overriding the picked date field", async () => {
    const result = await runReportBuilder(tdb, {
      ...baseInput,
      filters: { stage: [WON_SLUG], from: "2026-03-01", to: "2026-03-31" },
    });

    // Axis forced to won_closed_date: the March-won deal (created Jan) is counted in 2026-03; the
    // Feb-won deal (created March) is NOT — even though its created_at is in the March range.
    const march = result.rows.find((r) => r.month === "2026-03");
    expect(march).toBeTruthy();
    expect(Number(march!.total_value)).toBeCloseTo(100000, 2);
    expect(result.rows.some((r) => r.month === "2026-02")).toBe(false);
    expect(result.rows.some((r) => Math.abs(Number(r.total_value) - 50000) < 0.01)).toBe(false);
    // The forced basis is surfaced.
    expect(result.notes?.some((n) => n.includes("won_closed_date"))).toBe(true);
  });

  it("without a Won-only stage filter, keeps the user's selected date axis (created_at)", async () => {
    const result = await runReportBuilder(tdb, {
      ...baseInput,
      filters: { from: "2026-03-01", to: "2026-03-31" },
    });

    // Axis is created_at: the Feb-won deal (CREATED March) is counted; the Jan-created one is not.
    const march = result.rows.find((r) => r.month === "2026-03");
    expect(march).toBeTruthy();
    expect(Number(march!.total_value)).toBeCloseTo(50000, 2);
    expect(result.notes ?? []).toHaveLength(0);
  });
});
