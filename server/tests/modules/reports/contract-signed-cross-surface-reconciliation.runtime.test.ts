import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { runReportBuilder } from "../../../src/modules/reports/report-builder-service.js";
import {
  getCanonicalRepWonSummary,
  getWonCloseSummary,
} from "../../../src/modules/dashboard/service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";
import { resolveWonClosedDateWriteThrough } from "../../../src/modules/shared/won-close-date.js";

/**
 * MANDATORY cross-surface guard for the contract-signed → won_closed_date WRITE-THROUGH.
 *
 * The write-time override populates the ONE stored column (deals.won_closed_date); this test
 * proves every independently-composed Won surface still bucket-windows to the SAME count/value
 * for the SAME window once that column carries write-through values — i.e. the override did NOT
 * reintroduce a cross-surface mismatch (the cardinal Won-basis invariant).
 *
 * It seeds Won-family deals in all THREE write-through states the writers produce, plus the two
 * safety cases:
 *   A) contract-signed PRESENT  → won_closed_date = the contract date (override won)
 *   B) contract-signed ABSENT   → won_closed_date = the original stage stamp
 *   C) contract-signed CLEARED  → won_closed_date = stage_entry date (revert basis)
 *   NP) NON-Won deal with a contract-signed date IN-window but won_closed_date NULL
 *       → must NEVER appear on a Won surface (no promotion; membership stays gated by stage)
 *   OW) Won deal whose won_closed_date is OUT of the window → excluded everywhere
 *
 * LOAD-BEARING for the override PRECEDENCE (not merely read-agreement): each deal's STORED
 * won_closed_date is computed by calling the REAL write-through resolver, and deal A's stage-driven
 * fallback (STAGE_FALLBACK_A) is deliberately OUT of the window. So only a CORRECT resolver
 * (contract-signed wins) keeps A in-window and counted — invert the resolver and A falls to its
 * out-of-window stage date, dropping the count/value on all three surfaces and failing this guard.
 * Each writer's USE of the resolver is separately proven by the contract-signed-date /
 * stage-change / bidboard-mirror unit tests (which assert the resolved column value).
 *
 * Surfaces asserted in real SQL: the Director "Closed" card (getWonCloseSummary), its per-rep
 * decomposition (getCanonicalRepWonSummary), and report-builder full-Won scope (runReportBuilder).
 * The remaining Won surfaces (sales-tier1 / performance-tier2 / analytics-tier4 / legacy reports /
 * monday-showcase evidence / the /deals Won drill-down) all read the SAME deals.won_closed_date
 * column through the SAME aliasedWonHsClosedWonDateSql helper — proven by their per-tier SQL-shape
 * guards — so they inherit the corrected date by construction.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const ALL_WON = [...WON_STAGE_SLUGS];
const REP1 = U("a01");
const REP2 = U("a02");
const ST = { won: U("57001"), open: U("57002") };
const D = {
  present: U("11001"),
  absent: U("11002"),
  cleared: U("11003"),
  noPromotion: U("11004"),
  outOfWindow: U("11005"),
};
const WINDOW = { from: "2026-02-01", to: "2026-02-28" };
// In-window Won set = present(100k) + absent(50k) + cleared(30k).
const EXPECTED_COUNT = 3;
const EXPECTED_VALUE = 180000;

// Deal A's stage-driven fallback is OUT of the window on purpose — a correct resolver (contract
// wins) must override it back IN-window. Each stored won_closed_date is the resolver's real output.
const STAGE_FALLBACK_A = "2026-09-01"; // out of the Feb window
const WON_DATE = {
  // A: contract present (2026-02-10) must win over the out-of-window stage fallback.
  present: resolveWonClosedDateWriteThrough({ contractSignedDate: "2026-02-10", stageDrivenWonDate: STAGE_FALLBACK_A }),
  // B: contract absent → original stage stamp stands.
  absent: resolveWonClosedDateWriteThrough({ contractSignedDate: null, stageDrivenWonDate: "2026-02-20" }),
  // C: contract cleared → stage-entry revert date stands.
  cleared: resolveWonClosedDateWriteThrough({ contractSignedDate: null, stageDrivenWonDate: "2026-02-25" }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
const admin = { dateField: "created_at" as const, role: "admin" as const, userId: "admin-1" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, assigned_rep_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date, actual_close_date date, contract_signed_date date, created_at timestamptz, source text DEFAULT 'Website',
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO users (id, display_name) VALUES ('${REP1}','Alice'), ('${REP2}','Bob');
    INSERT INTO pipeline_stage_config (id, slug, name) VALUES ('${ST.won}','${WON_SLUG}','Won'), ('${ST.open}','opportunity','Opportunity');

    -- A) contract-signed PRESENT: won_closed_date == the resolver's output (contract date wins over
    -- the out-of-window stage fallback), in window ONLY if the resolver is correct.
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, contract_signed_date, created_at, awarded_amount) VALUES
      ('${D.present}','${REP1}','${ST.won}', '${WON_DATE.present}','2026-02-10','2026-01-05T00:00:00Z', 100000);
    -- B) contract-signed ABSENT: won_closed_date == original stage stamp, in window.
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, contract_signed_date, created_at, awarded_amount) VALUES
      ('${D.absent}','${REP1}','${ST.won}', '${WON_DATE.absent}', NULL,'2026-01-10T00:00:00Z', 50000);
    -- C) contract-signed CLEARED: won_closed_date == stage-entry revert date, in window.
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, contract_signed_date, created_at, awarded_amount) VALUES
      ('${D.cleared}','${REP2}','${ST.won}', '${WON_DATE.cleared}', NULL,'2026-01-15T00:00:00Z', 30000);
    -- NP) NON-Won deal with an in-window contract date but NULL won_closed_date — must never count as Won.
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, contract_signed_date, created_at, awarded_amount) VALUES
      ('${D.noPromotion}','${REP1}','${ST.open}', NULL,'2026-02-12','2026-01-20T00:00:00Z', 999999);
    -- OW) Won deal whose won_closed_date is OUT of the window — excluded from the windowed surfaces.
    INSERT INTO deals (id, assigned_rep_id, stage_id, won_closed_date, contract_signed_date, created_at, awarded_amount) VALUES
      ('${D.outOfWindow}','${REP2}','${ST.won}', '2026-05-01','2026-05-01','2026-04-01T00:00:00Z', 777777);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("contract-signed write-through keeps every Won surface cross-surface consistent", () => {
  it("the write-through resolver makes contract-signed win, pulling deal A back into the window", () => {
    // Load-bearing precedence check: if the resolver were inverted (contract-signed loses), A's
    // stored won_closed_date would be the out-of-window STAGE_FALLBACK_A and every assertion below
    // that depends on the count being 3 / value 180000 would fail.
    expect(WON_DATE.present).toBe("2026-02-10");
    expect(WON_DATE.present).not.toBe(STAGE_FALLBACK_A);
  });

  it("the Closed card windows to exactly the 3 in-window Won deals across all write-through states", async () => {
    const card = await getWonCloseSummary(tdb, WINDOW);
    expect(card.count).toBe(EXPECTED_COUNT);
    expect(card.totalValue).toBeCloseTo(EXPECTED_VALUE, 2);
    // No promotion (999999 absent) and out-of-window (777777 absent) — both proven by the totals.
    expect(card.totalValue).not.toBeCloseTo(EXPECTED_VALUE + 999999, 2);
    expect(card.totalValue).not.toBeCloseTo(EXPECTED_VALUE + 777777, 2);
  });

  it("the per-rep decomposition sums to the Closed card exactly (by construction)", async () => {
    const card = await getWonCloseSummary(tdb, WINDOW);
    const reps = await getCanonicalRepWonSummary(tdb, WINDOW);
    const repCount = reps.reduce((s, r) => s + r.winsCount, 0);
    const repValue = reps.reduce((s, r) => s + r.closedValue, 0);
    expect(repCount).toBe(card.count);
    expect(repValue).toBeCloseTo(card.totalValue, 2);
    // Alice (present + absent) = 150k / 2 wins; Bob (cleared) = 30k / 1 win.
    const alice = reps.find((r) => r.repId === REP1)!;
    const bob = reps.find((r) => r.repId === REP2)!;
    expect(alice.winsCount).toBe(2);
    expect(alice.closedValue).toBeCloseTo(150000, 2);
    expect(bob.winsCount).toBe(1);
    expect(bob.closedValue).toBeCloseTo(30000, 2);
  });

  it("report-builder full-Won scope reconciles to the Closed card for the same window", async () => {
    const card = await getWonCloseSummary(tdb, WINDOW);
    const report = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["rep"],
      measures: ["deal_count", "total_value"],
      filters: { stage: ALL_WON, ...WINDOW },
    });
    const reportCount = report.rows.reduce((s, r) => s + Number(r.deal_count), 0);
    const reportValue = report.rows.reduce((s, r) => s + Number(r.total_value), 0);
    expect(reportCount).toBe(card.count);
    expect(reportValue).toBeCloseTo(card.totalValue, 2);
    expect(report.notes?.[0]).toMatch(/reconcile/i);
  });

  it("all three surfaces agree on the SAME number for the SAME window (the invariant)", async () => {
    const card = await getWonCloseSummary(tdb, WINDOW);
    const reps = await getCanonicalRepWonSummary(tdb, WINDOW);
    const report = await runReportBuilder(tdb, {
      ...admin,
      dimensions: ["rep"],
      measures: ["deal_count", "total_value"],
      filters: { stage: ALL_WON, ...WINDOW },
    });
    const repValue = reps.reduce((s, r) => s + r.closedValue, 0);
    const reportValue = report.rows.reduce((s, r) => s + Number(r.total_value), 0);

    // One number, three surfaces — the cross-surface Won invariant the write-through must preserve.
    expect(card.totalValue).toBeCloseTo(repValue, 2);
    expect(card.totalValue).toBeCloseTo(reportValue, 2);
    expect(card.totalValue).toBeCloseTo(EXPECTED_VALUE, 2);
  });
});
