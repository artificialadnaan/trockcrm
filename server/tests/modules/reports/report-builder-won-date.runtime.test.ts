import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { runReportBuilder } from "../../../src/modules/reports/report-builder-service.js";
import { getWonCloseSummary } from "../../../src/modules/dashboard/service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) proof for report-builder Decision 1 (+ the GREEN/Codex follow-ups):
 *  - A Won-only stage filter forces BOTH the period axis (won_closed_date) AND the value basis
 *    (the canonical awarded-first effective Won value) — so a Won custom report RECONCILES to the
 *    Won card (getWonCloseSummary), not just the date.
 *  - The usable-won-date guard is applied ONLY for period-bounded reports; an all-time Won report
 *    still COUNTS Won deals with a null won_closed_date (no undercount).
 *  - A report with no Won-only stage filter keeps the user's chosen axis (and open value basis).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const REP = U("a01");
const ST = { won: U("57001"), open: U("57002") };
const D = { wonMar: U("11001"), wonApr: U("11002"), wonNull: U("11003") };

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

    -- wonMar: won March, created Jan; awarded(100k) != bid_board(70k) -> canonical value must be 100k
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, created_at, awarded_amount, bid_board_total_sales) VALUES
      ('${D.wonMar}','${REP}','${ST.won}','2026-03-15','2026-01-05T00:00:00Z', 100000, 70000);
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, created_at, awarded_amount) VALUES
      ('${D.wonApr}','${REP}','${ST.won}','2026-04-10','2026-03-20T00:00:00Z', 50000),
      -- wonNull: WON but no won_closed_date -> excluded from PERIOD reports, counted in ALL-TIME ones
      ('${D.wonNull}','${REP}','${ST.won}', NULL, '2026-02-01T00:00:00Z', 30000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

const admin = { dateField: "created_at" as const, role: "admin" as const, userId: "admin-1" };

describe("report-builder Decision 1 — Won reports reconcile to the Won card", () => {
  it("period-bounded Won report: won_closed_date axis + canonical awarded-first value, reconciles to getWonCloseSummary", async () => {
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["month"],
      measures: ["total_value"],
      filters: { stage: [WON_SLUG], ...range },
    });

    // Axis is won_closed_date: wonMar (created Jan) buckets in 2026-03, NOT 2026-01.
    const march = result.rows.find((r) => r.month === "2026-03");
    expect(march).toBeTruthy();
    // VALUE is the canonical awarded-first Won value (100000), NOT best-estimate-first (70000).
    expect(Number(march!.total_value)).toBeCloseTo(100000, 2);
    expect(result.rows.some((r) => r.month === "2026-01")).toBe(false);

    // RECONCILIATION: SUM(report total_value) === getWonCloseSummary.totalValue for the same window.
    const reportTotal = result.rows.reduce((s, r) => s + Number(r.total_value), 0);
    const card = await getWonCloseSummary(tdb, range);
    expect(card.totalValue).toBeCloseTo(150000, 2); // wonMar 100k + wonApr 50k (wonNull excluded: no won date)
    expect(reportTotal).toBeCloseTo(card.totalValue, 2);
    expect(result.notes?.some((n) => n.includes("won_closed_date"))).toBe(true);
  });

  it("all-time Won report (no from/to, no time bucket) still counts null-won-date deals", async () => {
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["rep"],
      measures: ["deal_count", "total_value"],
      filters: { stage: [WON_SLUG] },
    });
    const row = result.rows.find((r) => r.rep === "Alice");
    expect(row).toBeTruthy();
    // All three won deals count — incl. wonNull (null won_closed_date); the guard is NOT applied.
    expect(Number(row!.deal_count)).toBe(3);
    // Canonical awarded-first value: 100000 + 50000 + 30000 (wonMar uses 100k, not its 70k bid-board).
    expect(Number(row!.total_value)).toBeCloseTo(180000, 2);
  });

  it("non-Won report keeps the user's date axis (created_at)", async () => {
    const result = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["month"],
      measures: ["total_value"],
      filters: { from: "2026-03-01", to: "2026-03-31" },
    });
    // created_at axis: only wonApr (created 2026-03-20) is in range; wonMar (created Jan) is not.
    const march = result.rows.find((r) => r.month === "2026-03");
    expect(march).toBeTruthy();
    expect(Number(march!.total_value)).toBeCloseTo(50000, 2);
    expect(result.notes ?? []).toHaveLength(0);
  });
});
