import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, type SQL } from "drizzle-orm";
import { terminalOutcomeDateSql } from "../../../src/modules/reports/sales-tier1-service.js";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) by-construction proof for the sales-tier1 Won-date migration (FIX-2/FIX-4).
 *
 * terminalOutcomeDateSql() is the period/bucket axis for getClosedWonRevenueReport. Its WON
 * (ELSE) arm is migrated to the canonical deals.won_closed_date — so a deal merely TOUCHED in
 * period (updated_at) or with a reseed-contaminated actual_close_date is no longer counted as
 * won-in-period. The LOST arm (actual_close_date / stage_entered_at) is intentionally left
 * unchanged, so the win/loss summary's lost count does not shift.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const LOST_SLUG = LOST_STAGE_SLUGS[0];
const ST = { won: U("57001"), lost: U("57002") };
const D = {
  wonIn: U("11001"), wonTouched: U("11002"), wonOut: U("11003"),
  lostIn: U("11004"), lostOut: U("11005"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
function execRows(q: SQL): Promise<Array<Record<string, unknown>>> {
  return tdb
    .execute(q)
    .then((r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Array<Record<string, unknown>>);
}
const FROM = "2026-03-01";
const TO = "2026-03-31";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, stage_id uuid NOT NULL,
      won_closed_date date, actual_close_date date,
      contract_signed_at timestamptz, stage_entered_at timestamptz, updated_at timestamptz
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST.won}','${WON_SLUG}'), ('${ST.lost}','${LOST_SLUG}');

    -- window = 2026-03-01 .. 2026-03-31
    INSERT INTO deals (id, stage_id, won_closed_date, actual_close_date, contract_signed_at, stage_entered_at, updated_at) VALUES
      -- won, canonical in-window, every legacy field OUTSIDE -> counted (canonical won)
      ('${D.wonIn}','${ST.won}','2026-03-15', '2026-01-02', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
      -- won stage, NO canonical date, only touched + contract-signed in-window -> NOT counted (the fix)
      ('${D.wonTouched}','${ST.won}', NULL, '2026-03-09', '2026-03-09T00:00:00Z', '2026-03-09T00:00:00Z', '2026-03-09T00:00:00Z'),
      -- won, canonical OUTSIDE window, legacy fields in-window -> NOT counted
      ('${D.wonOut}','${ST.won}','2026-02-01', '2026-03-09', '2026-03-09T00:00:00Z', '2026-03-09T00:00:00Z', '2026-03-09T00:00:00Z'),
      -- lost, LOST arm (actual_close_date) in-window -> counted (unchanged)
      ('${D.lostIn}','${ST.lost}', NULL, '2026-03-12', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      -- lost, LOST arm out-of-window -> NOT counted
      ('${D.lostOut}','${ST.lost}', NULL, '2026-01-05', NULL, '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("sales-tier1 FIX-2: terminalOutcomeDateSql WON arm = canonical won_closed_date", () => {
  it("won outcome date is won_closed_date; lost arm stays on actual_close_date", async () => {
    const rows = await execRows(sql`
      SELECT d.id::text AS id, p.slug, (${terminalOutcomeDateSql()})::date::text AS outcome_date
      FROM deals d JOIN pipeline_stage_config p ON p.id = d.stage_id
    `);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.outcome_date]));
    expect(byId[D.wonIn]).toBe("2026-03-15"); // won_closed_date, not contract_signed_at/updated_at
    expect(byId[D.wonOut]).toBe("2026-02-01"); // canonical, ignoring the in-window legacy fields
    expect(byId[D.lostIn]).toBe("2026-03-12"); // LOST arm unchanged (actual_close_date)
  });

  it("won_at window counts won by won_closed_date (touched-not-won excluded); lost preserved", async () => {
    const outcome = terminalOutcomeDateSql();
    const rows = await execRows(sql`
      SELECT d.id::text AS id, p.slug
      FROM deals d JOIN pipeline_stage_config p ON p.id = d.stage_id
      WHERE ${outcome} >= ${FROM}::date AND ${outcome} < (${TO}::date + INTERVAL '1 day')
    `);
    const ids = new Set(rows.map((r) => r.id));
    const wonCounted = new Set(rows.filter((r) => r.slug === WON_SLUG).map((r) => r.id));

    expect(wonCounted).toEqual(new Set([D.wonIn])); // only the canonical-in-window won deal
    expect(ids.has(D.wonTouched)).toBe(false); // Won-lock row-level: touched/signed in-period but no won date
    expect(ids.has(D.wonOut)).toBe(false); // won date outside window
    expect(ids.has(D.lostIn)).toBe(true); // lost count preserved on its own arm
    expect(ids.has(D.lostOut)).toBe(false);
  });
});
