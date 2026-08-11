import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, type SQL } from "drizzle-orm";
import {
  buildWonDateSql,
  buildForecastMonthBucketDateSql,
} from "../../../src/modules/reports/performance-tier2-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) by-construction proof for the perf-tier2 Won-date migration.
 *
 * FIX-1 (buildWonDateSql): the WON cohort is now windowed by the canonical app-owned
 * column deals.won_closed_date (mirroring dashboard getWonCloseSummary: IS NOT NULL +
 * >= from + <= to), so a deal merely TOUCHED in-period (updated_at) or reseed-contaminated
 * (actual_close_date) is no longer counted as won-in-period. The non-WON (lost) branch now
 * LEADS with the canonical deals.lost_at (PR-F Lost-unification), with the legacy
 * COALESCE(contract_signed_at, actual_close_date, updated_at) kept only as a FALLBACK for older
 * lost deals whose lost_at was never stamped — so a deal lost in-period by lost_at (legacy basis
 * out of window) is now counted in the win-rate DENOMINATOR, and no stamped-null lost deal drops.
 *
 * FIX-3 (buildForecastMonthBucketDateSql): a WON-STAGE deal lands in the month of its canonical
 * won_closed_date (not its expected/plan close month); every non-Won-stage deal — INCLUDING a
 * "reopened" deal that was Won, kept its won_closed_date, then moved back to an active stage —
 * buckets on the expected-close fallback chain (so it stays in its live forecast month).
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const LOST_SLUG = LOST_STAGE_SLUGS[0];
const OPEN_SLUG = "opportunity";
const ST = { won: U("57001"), lost: U("57002"), open: U("57003") };
const D = {
  wonIn: U("11001"), wonTouched: U("11002"), wonOut: U("11003"),
  lostIn: U("11004"), lostOut: U("11005"), openIn: U("11006"), lostByLostAt: U("11007"), lostTouchedOnly: U("11008"),
  bWon: U("12001"), bOpen: U("12002"), bFallback: U("12003"), bReopened: U("12004"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
function execRows(q: SQL): Promise<Array<Record<string, unknown>>> {
  return tdb
    .execute(q)
    .then((r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Array<Record<string, unknown>>);
}

const filters = { dateFrom: "2026-03-01", dateTo: "2026-03-31", office: undefined, ownerIds: [], ownerNames: [] };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, stage_id uuid NOT NULL,
      won_closed_date date, expected_close_date date, bid_due_date timestamptz, actual_close_date date,
      lost_at timestamptz, contract_signed_at timestamptz, contract_signed_date date, updated_at timestamptz
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('${ST.won}','${WON_SLUG}'), ('${ST.lost}','${LOST_SLUG}'), ('${ST.open}','${OPEN_SLUG}');

    -- FIX-1 window = 2026-03-01 .. 2026-03-31
    INSERT INTO deals (id, stage_id, won_closed_date, actual_close_date, contract_signed_at, updated_at) VALUES
      -- won, canonical date in-window, touched OUTSIDE -> MATCH (canonical won)
      ('${D.wonIn}','${ST.won}','2026-03-15', NULL, NULL, '2026-01-01T00:00:00Z'),
      -- won stage but NO canonical date, only touched in-window -> NO MATCH (the fix)
      ('${D.wonTouched}','${ST.won}', NULL, NULL, NULL, '2026-03-10T00:00:00Z'),
      -- won, canonical date OUTSIDE window, touched in-window -> NO MATCH
      ('${D.wonOut}','${ST.won}','2026-02-01', NULL, NULL, '2026-03-10T00:00:00Z'),
      -- lost, legacy basis (actual_close_date) in-window -> MATCH (denominator preserved)
      ('${D.lostIn}','${ST.lost}', NULL, '2026-03-12', NULL, '2026-01-01T00:00:00Z'),
      -- lost, legacy basis out-of-window -> NO MATCH
      ('${D.lostOut}','${ST.lost}', NULL, '2026-01-05', NULL, '2026-01-05T00:00:00Z'),
      -- open, touched in-window -> matches non-won branch (filtered by slug in real metrics)
      ('${D.openIn}','${ST.open}', NULL, NULL, NULL, '2026-03-10T00:00:00Z');

    -- PR-F Lost-unification: a deal lost in-window by canonical lost_at, with its legacy basis
    -- (actual_close_date / updated_at) OUTSIDE the window. The old legacy-only lost arm placed it in
    -- Jan 2026 -> NO MATCH; the new arm leads with lost_at -> MATCH (counted in the denominator).
    INSERT INTO deals (id, stage_id, won_closed_date, actual_close_date, lost_at, contract_signed_at, updated_at) VALUES
      ('${D.lostByLostAt}','${ST.lost}', NULL, '2026-01-05', '2026-03-12T00:00:00Z', NULL, '2026-01-05T00:00:00Z');

    -- PR-F Lost-unification (over-count removal): a deal lost OUT of window by canonical lost_at
    -- (Jan 2026) but merely TOUCHED in-window (updated_at = March). The old arm windowed on updated_at
    -- -> wrongly counted in the denominator; the new arm leads with lost_at -> correctly EXCLUDED. This
    -- pins the COALESCE ORDER (lost_at first), guarding against a regression that re-leads with updated_at.
    INSERT INTO deals (id, stage_id, won_closed_date, actual_close_date, lost_at, contract_signed_at, updated_at) VALUES
      ('${D.lostTouchedOnly}','${ST.lost}', NULL, NULL, '2026-01-20T00:00:00Z', NULL, '2026-03-10T00:00:00Z');

    -- FIX-3 month-bucket cases
    INSERT INTO deals (id, stage_id, won_closed_date, expected_close_date, updated_at) VALUES
      ('${D.bWon}','${ST.won}','2026-02-15','2026-03-20','2026-05-01T00:00:00Z'),
      ('${D.bOpen}','${ST.open}', NULL,'2026-03-20','2026-05-01T00:00:00Z'),
      ('${D.bFallback}','${ST.open}', NULL, NULL,'2026-04-05T00:00:00Z'),
      -- reopened-active: was Won (keeps a stale Feb won_closed_date) but is now in an OPEN stage
      -- with a March expected-close -> must bucket on expected (March), NOT the stale won month
      ('${D.bReopened}','${ST.open}','2026-02-15','2026-03-20','2026-05-01T00:00:00Z');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("perf-tier2 FIX-1: buildWonDateSql windows WON by canonical won_closed_date", () => {
  it("counts won by won_closed_date, excludes touched-but-not-won and out-of-window won", async () => {
    const rows = await execRows(sql`
      SELECT d.id::text AS id, psc.slug
      FROM deals d JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE ${buildWonDateSql(filters)}
    `);
    const ids = new Set(rows.map((r) => r.id));
    const wonMatched = new Set(rows.filter((r) => r.slug === WON_SLUG).map((r) => r.id));

    // WON side reconciles to the canonical predicate: ONLY the canonical-in-window won deal.
    expect(wonMatched).toEqual(new Set([D.wonIn]));
    // Row-level Won-lock: a deal touched in-period but without a usable won date is NOT won-in-period.
    expect(ids.has(D.wonTouched)).toBe(false);
    // A won deal whose canonical date is outside the window is not counted (no updated_at leak).
    expect(ids.has(D.wonOut)).toBe(false);

    // LOST side now LEADS with canonical lost_at (PR-F), with the legacy chain as fallback:
    //  - lostIn: lost_at NULL, legacy basis (actual_close_date) in-window -> still matches (fallback preserved).
    //  - lostOut: lost_at NULL, legacy basis out-of-window -> still no match.
    //  - lostByLostAt: lost_at in-window but legacy basis OUT -> now matches on the canonical date (the fix).
    //  - lostTouchedOnly: lost_at OUT but updated_at in-window -> now correctly EXCLUDED (over-count removed).
    expect(ids.has(D.lostIn)).toBe(true);
    expect(ids.has(D.lostOut)).toBe(false);
    expect(ids.has(D.lostByLostAt)).toBe(true);
    expect(ids.has(D.lostTouchedOnly)).toBe(false);
  });
});

describe("perf-tier2 FIX-3: buildForecastMonthBucketDateSql buckets WON-STAGE by canonical won month", () => {
  it("won-stage -> won month; non-won (incl. reopened-active) -> expected_close; fallback preserved", async () => {
    const rows = await execRows(sql`
      SELECT d.id::text AS id, to_char(${buildForecastMonthBucketDateSql("d")}, 'YYYY-MM') AS bucket
      FROM deals d JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.id IN (${D.bWon}::uuid, ${D.bOpen}::uuid, ${D.bFallback}::uuid, ${D.bReopened}::uuid)
    `);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.bucket]));
    expect(byId[D.bWon]).toBe("2026-02"); // WON-stage: canonical won month wins over expected (2026-03)
    expect(byId[D.bOpen]).toBe("2026-03"); // open deal: expected_close_date, unchanged
    expect(byId[D.bFallback]).toBe("2026-04"); // legacy fallback chain (updated_at) preserved
    // Reopened-active (GREEN/Codex regression): a non-Won stage with a STALE won_closed_date must
    // bucket on its expected-close month, NOT the historical won month.
    expect(byId[D.bReopened]).toBe("2026-03");
    expect(byId[D.bReopened]).not.toBe("2026-02");
  });
});
