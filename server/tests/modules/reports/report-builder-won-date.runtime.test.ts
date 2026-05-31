import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { runReportBuilder } from "../../../src/modules/reports/report-builder-service.js";
import { getWonCloseSummary } from "../../../src/modules/dashboard/service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for report-builder Decision 1 + the Won-reconciliation follow-ups:
 *  - A full-Won-scope report forces the canonical won_closed_date axis AND the awarded-first Won
 *    value, and reconciles to getWonCloseSummary — INCLUDING inactive terminal Won deals (no
 *    is_active=true forced) and excluding null-won-date deals only for period-bounded reports.
 *  - avg_cycle_time for a Won report ages by won_closed_date, not actual_close_date.
 *  - The "reconciles to the card" note appears ONLY for a full Won-stage scope; a Won SUBSET says it
 *    will NOT match the full card.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const ALL_WON = [...WON_STAGE_SLUGS];
const REP = U("a01");
const ST = { won: U("57001"), open: U("57002") };
const D = { wonMar: U("11001"), wonAprInactive: U("11002"), wonNull: U("11003"), openMar: U("11004") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const admin = { dateField: "created_at" as const, role: "admin" as const, userId: "admin-1" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`); // deterministic created_at::date for the cycle-time assertion
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, assigned_rep_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date, actual_close_date date, created_at timestamptz,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
    INSERT INTO pipeline_stage_config (id, slug, name) VALUES ('${ST.won}','${WON_SLUG}','Won'), ('${ST.open}','opportunity','Opportunity');

    -- wonMar: ACTIVE won; won Mar / created Jan; awarded(100k) != bid_board(70k); actual_close_date NULL
    INSERT INTO deals (id, assigned_rep_id, stage_id, is_active, won_closed_date, created_at, awarded_amount, bid_board_total_sales) VALUES
      ('${D.wonMar}','${REP}','${ST.won}', true, '2026-03-15','2026-01-05T00:00:00Z', 100000, 70000);
    -- wonAprInactive: INACTIVE terminal won (the normal case) — must still be counted
    INSERT INTO deals (id, assigned_rep_id, stage_id, is_active, won_closed_date, created_at, awarded_amount) VALUES
      ('${D.wonAprInactive}','${REP}','${ST.won}', false, '2026-04-10','2026-03-20T00:00:00Z', 50000),
      -- wonNull: won but no won date -> excluded from period reports, counted all-time, no cycle age
      ('${D.wonNull}','${REP}','${ST.won}', true, NULL, '2026-02-01T00:00:00Z', 30000);
    -- openMar: ACTIVE open deal created in March (only appears in the non-Won created_at report)
    INSERT INTO deals (id, assigned_rep_id, stage_id, is_active, won_closed_date, created_at, awarded_amount) VALUES
      ('${D.openMar}','${REP}','${ST.open}', true, NULL, '2026-03-25T00:00:00Z', 25000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("report-builder Won reports reconcile to the Won card", () => {
  it("full Won scope, period-bounded: won_closed_date axis + canonical value + INACTIVE wins, reconciles to getWonCloseSummary", async () => {
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["month"],
      measures: ["total_value"],
      filters: { stage: ALL_WON, ...range },
    });

    const march = result.rows.find((r) => r.month === "2026-03");
    expect(Number(march!.total_value)).toBeCloseTo(100000, 2); // canonical awarded-first, not 70k
    // The inactive April win is counted (no is_active=true forced).
    const april = result.rows.find((r) => r.month === "2026-04");
    expect(Number(april!.total_value)).toBeCloseTo(50000, 2);

    const reportTotal = result.rows.reduce((s, r) => s + Number(r.total_value), 0);
    const card = await getWonCloseSummary(tdb, range);
    expect(card.totalValue).toBeCloseTo(150000, 2); // active wonMar + INACTIVE wonApr; wonNull excluded
    expect(reportTotal).toBeCloseTo(card.totalValue, 2);
    expect(result.notes?.[0]).toMatch(/reconcile/i);
  });

  it("all-time full Won scope counts null-won-date AND inactive deals", async () => {
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["rep"],
      measures: ["deal_count", "total_value"],
      filters: { stage: ALL_WON },
    });
    const row = result.rows.find((r) => r.rep === "Alice")!;
    expect(Number(row.deal_count)).toBe(3); // wonMar + inactive wonApr + null-date wonNull
    expect(Number(row.total_value)).toBeCloseTo(180000, 2); // 100k + 50k + 30k (awarded-first)
  });

  it("Won-scoped avg_cycle_time ages by won_closed_date, not actual_close_date", async () => {
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["rep"],
      measures: ["avg_cycle_time"],
      filters: { stage: ALL_WON },
    });
    const row = result.rows.find((r) => r.rep === "Alice")!;
    // wonMar: 2026-03-15 - 2026-01-05 = 69d; wonApr: 2026-04-10 - 2026-03-20 = 21d; wonNull: no won
    // date -> excluded from the average. avg = (69 + 21) / 2 = 45. actual_close_date is NULL for all,
    // so the pre-fix actual_close_date basis would have produced 0 / excluded every row.
    expect(Number(row.avg_cycle_time)).toBeCloseTo(45, 0);
  });

  it("a Won SUBSET does not promise card reconciliation", async () => {
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["rep"],
      measures: ["total_value"],
      filters: { stage: [WON_SLUG] }, // one of several Won slugs -> subset of the card scope
    });
    expect(result.notes?.[0]).toMatch(/subset/i);
    expect(result.notes?.[0]).not.toMatch(/totals reconcile to the won card/i);
  });

  it("non-Won report keeps the user's date axis (created_at)", async () => {
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["month"],
      measures: ["total_value"],
      filters: { from: "2026-03-01", to: "2026-03-31" },
    });
    const march = result.rows.find((r) => r.month === "2026-03");
    // Only the ACTIVE open deal created 2026-03-25 (wonApr is inactive -> excluded by is_active here).
    expect(Number(march!.total_value)).toBeCloseTo(25000, 2);
    expect(result.notes ?? []).toHaveLength(0);
  });
});
