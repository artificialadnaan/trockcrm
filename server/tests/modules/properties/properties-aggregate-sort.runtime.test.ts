import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * REAL-SQL runtime coverage (PGlite) for the FOLDED Engagement + Last touch sorts on /properties.
 *
 * Both are computed via 1:1 LEFT JOINs into the main list query (da = deal aggregate, la = lead aggregate)
 * so the server ORDER BY sorts the FULL filtered set before LIMIT:
 *   - engagement  → COALESCE(da.active_cnt, 0)  (active, not-on-hold deals — the SAME count the cell shows)
 *   - last_touch  → GREATEST(properties.last_activity_at, la.last_activity, da.last_activity)  (== the cell)
 *
 * The point of this suite: prove (1) the sort runs over the full set (a high property OUTSIDE the window
 * surfaces to the top), (2) reconciliation — the sorted order matches the DISPLAYED activeDealsCount /
 * lastActivityAt the cell renders, (3) on-hold deals are excluded from the engagement count, (4) zero /
 * no-activity properties sink last.
 *
 * Fixture (12 properties, one company, default order = name ASC):
 *   - Prop 12: 3 active deals, deal activity 2026-06-10  → active_cnt 3 (top engagement)
 *   - Prop 05: 2 active deals, deal activity 2026-05-01  → active_cnt 2
 *   - Prop 03: 1 active + 1 ON-HOLD deal, activity 2026-04-01 → active_cnt 1 (on-hold NOT counted)
 *   - Prop 08: 1 active deal, deal activity 2026-03-01  → active_cnt 1
 *   - Prop 02: NO deals, one lead activity 2026-06-15   → active_cnt 0, last touch from the lead
 *   - Prop 10: NO deals/leads, property.last_activity_at 2026-06-20 → active_cnt 0, last touch from the column
 *   - all others: nothing → active_cnt 0, last touch NULL
 */

const T = "office_aggsort";
const COMPANY = "00000000-0000-0000-0000-0000000000c1";
const TOTAL = 12;

const pid = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
const propName = (i: number) => `Prop ${String(i).padStart(2, "0")}`;

let pg: PGlite;
let tdb: never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE ${T}.companies (
      id uuid PRIMARY KEY, name varchar(500) NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${T}.properties (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, name varchar(500) NOT NULL,
      address text, city varchar(255), state varchar(2), zip varchar(10), type text,
      build_year integer, unit_count integer, floors integer, roof_area integer, notes text,
      last_activity_at timestamptz, procore_id text, companycam_id text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${T}.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, property_id uuid, source_lead_id uuid,
      forecast_revenue numeric(14,2), awarded_amount numeric(14,2), bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2), dd_estimate numeric(14,2),
      on_hold boolean NOT NULL DEFAULT false, expected_close_date date, last_activity_at timestamptz, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${T}.leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid,
      last_activity_at timestamptz, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${T}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, lead_id uuid, category text,
      is_active boolean NOT NULL DEFAULT true
    );
    SET search_path TO ${T}, public;
  `);

  await pg.exec(`INSERT INTO ${T}.companies (id, name) VALUES ('${COMPANY}', 'Agg Co');`);

  const propValues: string[] = [];
  for (let i = 1; i <= TOTAL; i++) {
    // Prop 10 carries a property-level last_activity_at (its only activity source).
    const lastActivity = i === 10 ? "'2026-06-20T00:00:00Z'" : "NULL";
    propValues.push(`('${pid(i)}', '${COMPANY}', '${propName(i)}', ${lastActivity})`);
  }
  await pg.exec(
    `INSERT INTO ${T}.properties (id, company_id, name, last_activity_at) VALUES ${propValues.join(",")};`
  );

  await pg.exec(`
    INSERT INTO ${T}.deals (property_id, company_id, on_hold, last_activity_at, is_active) VALUES
      ('${pid(12)}', '${COMPANY}', false, '2026-06-10T00:00:00Z', true),
      ('${pid(12)}', '${COMPANY}', false, '2026-06-09T00:00:00Z', true),
      ('${pid(12)}', '${COMPANY}', false, '2026-06-08T00:00:00Z', true),
      ('${pid(5)}',  '${COMPANY}', false, '2026-05-01T00:00:00Z', true),
      ('${pid(5)}',  '${COMPANY}', false, '2026-04-15T00:00:00Z', true),
      ('${pid(3)}',  '${COMPANY}', false, '2026-04-01T00:00:00Z', true),
      ('${pid(3)}',  '${COMPANY}', true,  '2026-03-15T00:00:00Z', true),  -- ON-HOLD: excluded from the engagement count; older than the active deal so last touch stays 04-01
      ('${pid(8)}',  '${COMPANY}', false, '2026-03-01T00:00:00Z', true);
  `);

  await pg.exec(`
    INSERT INTO ${T}.leads (property_id, last_activity_at, is_active) VALUES
      ('${pid(2)}', '2026-06-15T00:00:00Z', true);
  `);

  tdb = drizzle(pg) as never;
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function listProperties(filters: Record<string, unknown>) {
  const { listProperties: real } = await import("../../../src/modules/properties/service.js");
  return real(tdb, filters as never);
}
const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);
const isDescNullsLast = (vals: Array<number | null>) => {
  // non-null values weakly descending, all nulls after the last non-null
  let seenNull = false;
  let prev = Infinity;
  for (const v of vals) {
    if (v == null) { seenNull = true; continue; }
    if (seenNull) return false;        // a value AFTER a null → nulls not last
    if (v > prev) return false;        // not descending
    prev = v;
  }
  return true;
};

describe("listProperties — Engagement + Last touch folded sorts", () => {
  it("ENGAGEMENT desc sorts by the active-deal count; on-hold excluded; full-set before LIMIT", async () => {
    // limit 3 < the global top engagements: a full-set sort must still return the global top 3, not
    // the default-by-name page (which would be Prop 01/02/03).
    const top = await listProperties({ sortBy: "engagement", sortDir: "desc", limit: 3 });
    expect(names(top.properties)).toEqual(["Prop 12", "Prop 05", "Prop 03"]); // 3, 2, then 1 (id tiebreak: 03 before 08)
    expect(top.properties.map((p: any) => p.activeDealsCount)).toEqual([3, 2, 1]);
    // Prop 03 has 2 deals but one is ON-HOLD → active count is 1, not 2.
    expect((top.properties[2] as any).activeDealsCount).toBe(1);
  });

  it("ENGAGEMENT reconciles: the sorted order is exactly the displayed activeDealsCount, zeros last", async () => {
    const all = await listProperties({ sortBy: "engagement", sortDir: "desc", limit: 50 });
    const counts = all.properties.map((p: any) => p.activeDealsCount as number);
    expect(counts.slice(0, 4)).toEqual([3, 2, 1, 1]); // Prop 12, 05, then 03 & 08
    expect(counts.every((c) => typeof c === "number")).toBe(true);
    // Monotonic non-increasing across the whole set → the cell value IS the sort key (no drift).
    expect(isDescNullsLast(counts)).toBe(true);
    // The eight no-active-deal properties tail out at 0.
    expect(counts.filter((c) => c === 0)).toHaveLength(8);
  });

  it("LAST TOUCH desc folds GREATEST(property, lead, deal activity) and reconciles with the cell", async () => {
    const sorted = await listProperties({ sortBy: "last_touch", sortDir: "desc", limit: 50 });
    // Prop 10 (property col 06-20) > Prop 02 (lead 06-15) > Prop 12 (deal 06-10) > Prop 05 > Prop 03 > Prop 08
    expect(names(sorted.properties).slice(0, 6)).toEqual([
      "Prop 10", "Prop 02", "Prop 12", "Prop 05", "Prop 03", "Prop 08",
    ]);
    const times = sorted.properties.map((p: any) => {
      if (p.lastActivityAt == null) return null;
      const t = new Date(p.lastActivityAt).getTime();
      expect(Number.isFinite(t)).toBe(true); // a displayed last touch must parse to a real instant first
      return t;
    });
    expect(isDescNullsLast(times)).toBe(true); // sorted value == the displayed lastActivityAt, nulls last
    // The six properties with no activity anywhere sink to the bottom as nulls.
    expect(times.filter((t) => t == null)).toHaveLength(6);
  });

  it("LAST TOUCH desc is a FULL-set sort: a recent property outside the default window surfaces with limit 3", async () => {
    // Prop 10 sits at name-position 10 (outside a 3-row default window) but has the most recent activity
    // (property column 2026-06-20), so a full-set last_touch sort must still pull it to the top of page 1.
    const top = await listProperties({ sortBy: "last_touch", sortDir: "desc", limit: 3 });
    expect(names(top.properties)).toEqual(["Prop 10", "Prop 02", "Prop 12"]);
  });

  it("LAST TOUCH asc lists oldest→newest with no-activity (null) properties last (NULLS LAST both ways)", async () => {
    const asc = await listProperties({ sortBy: "last_touch", sortDir: "asc", limit: 50 });
    const times = asc.properties.map((p: any) =>
      p.lastActivityAt ? new Date(p.lastActivityAt).getTime() : null
    );
    // The builder appends NULLS LAST in BOTH directions, so ascending = oldest non-null first, nulls at the end.
    expect(names(asc.properties)[0]).toBe("Prop 08"); // 2026-03-01 oldest
    const nonNull = times.filter((t): t is number => t != null);
    expect(nonNull).toEqual([...nonNull].sort((a, b) => a - b)); // strictly ascending
    expect(times.slice(-6).every((t) => t == null)).toBe(true); // the 6 no-activity properties sink last
  });
});
