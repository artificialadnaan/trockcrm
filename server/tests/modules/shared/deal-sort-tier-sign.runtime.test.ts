import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  aliasedActiveNonZeroDealSortTierSql,
  aliasedDealAwardedFirstWithFallbackSql,
} from "../../../src/modules/shared/deal-value-sql.js";

/**
 * The two-tier sort key is the LEADING ORDER BY key on the deals list and on every board column, so
 * whatever it does happens regardless of the column the user asked to sort by. It is a LIVENESS
 * partition — it exists to demote DEAD rows (parked, or carrying no value at all) — and its `> 0` test
 * was shorthand for "non-zero" that only held while every value in the system was non-negative.
 *
 * A DEDUCTIVE change order is a live Won child deal at a NEGATIVE value, so `> 0` filed every one of
 * them with the dead rows: behind every active card AND behind every on-hold/$0 row, under every sort.
 * With an 8-card web board preview / 15 on mobile-crm and a paginated list — against a header count and
 * total that include the deduction — that is a card/aggregate reconciliation break, not just an
 * ordering preference.
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const D = { active: U("d001"), deductive: U("d002"), zero: U("d003"), held: U("d004"), small: U("d005") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  tdb = drizzle(pg);
  await tdb.execute(sql`
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false,
      awarded_amount numeric(14,2),
      bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2)
    )
  `);
  // Names are chosen so plain alphabetical order is active < deductive < held < small < zero — i.e. the
  // deductive CO belongs SECOND under a name sort, which can only happen once the tier stops overriding it.
  await tdb.execute(sql`
    INSERT INTO deals (id, name, is_change_order, on_hold, awarded_amount, bid_estimate) VALUES
      (${D.active},    'active',    false, false, 100000.00, NULL),
      (${D.small},     'small',     false, false, 5000.00,   NULL),
      (${D.deductive}, 'deductive', true,  false, -20000.00, NULL),
      (${D.zero},      'zero',      false, false, NULL,      NULL),
      (${D.held},      'held',      false, true,  500000.00, NULL)
  `);
});

afterAll(async () => {
  await pg.close();
});

const VALUE_SQL = aliasedDealAwardedFirstWithFallbackSql("deals");
const TIER = aliasedActiveNonZeroDealSortTierSql("deals", VALUE_SQL);

async function orderedNames(then: string) {
  const result = await tdb.execute(sql`
    SELECT name FROM deals ORDER BY ${TIER} ASC, ${sql.raw(then)}, deals.id ASC
  `);
  const rows = (result.rows ?? result) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

async function tierOf(name: string) {
  const result = await tdb.execute(sql`SELECT ${TIER} AS tier FROM deals WHERE name = ${name}`);
  const rows = (result.rows ?? result) as Array<{ tier: number }>;
  return Number(rows[0]?.tier);
}

describe("aliasedActiveNonZeroDealSortTierSql — a non-zero, not positive-only, liveness tier", () => {
  it("puts a deductive change order in the LIVE tier, and still sinks the on-hold and $0 rows", async () => {
    expect(await tierOf("active")).toBe(0);
    expect(await tierOf("deductive")).toBe(0);
    // The tier still does the job it exists for.
    expect(await tierOf("zero")).toBe(1);
    expect(await tierOf("held")).toBe(1);
  });

  it("orders a deductive change order normally under a NAME sort", async () => {
    expect(await orderedNames("deals.name ASC")).toEqual([
      "active",
      "deductive",
      "small",
      "held",
      "zero",
    ]);
  });

  it("value DESCENDING: the deduction is last among live rows without being filed under the dead ones", async () => {
    // The owner's intent — a deduction must not top a money ranking — is satisfied by the SORT: a
    // negative is simply the smallest number. It needs no tier help, and sitting just above the $0/held
    // rows (rather than behind them) is what keeps it reachable on a previewed/paginated surface.
    expect(await orderedNames("deals.awarded_amount DESC NULLS LAST")).toEqual([
      "active",
      "small",
      "deductive",
      "held",
      "zero",
    ]);
  });

  it("value ASCENDING: the deduction comes FIRST, where smallest-first genuinely puts it", async () => {
    // The case a sort-aware tier gets wrong: keeping the bottom tier "whenever sorting by value" would
    // force the smallest number LAST in a smallest-first sort.
    expect(await orderedNames("deals.awarded_amount ASC NULLS LAST")).toEqual([
      "deductive",
      "small",
      "active",
      "held",
      "zero",
    ]);
  });

  it("is INERT for every row that is not a deductive change order", async () => {
    // The whole safety argument for `<> 0` in one query: for a non-CO row the value chain is a
    // COALESCE of `> 0`-gated candidates with a 0 fallback, so it can never go below zero and the two
    // operators must agree. Only a change-order child with a negative awarded_amount can differ.
    const legacyTier = sql`CASE WHEN COALESCE(deals.on_hold, false) = false AND ${VALUE_SQL} > 0 THEN 0 ELSE 1 END`;
    const result = await tdb.execute(sql`
      SELECT name, ${TIER} AS tier, ${legacyTier} AS legacy_tier FROM deals ORDER BY name
    `);
    const rows = (result.rows ?? result) as Array<{ name: string; tier: number; legacy_tier: number }>;

    const differing = rows.filter((row) => Number(row.tier) !== Number(row.legacy_tier));
    expect(differing.map((row) => row.name)).toEqual(["deductive"]);
    expect(rows).toHaveLength(5);
  });
});
