import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, type SQL } from "drizzle-orm";
import {
  UNASSIGNED_FILTER_SENTINEL,
  buildAliasedInvolvedRepSql,
  buildAliasedInvolvedRepInListSql,
} from "../../../src/modules/deals/deal-filter-predicates.js";

/**
 * REAL-SQL (PGlite) guard for the shared estimator-aware rep predicate that PR 2 fans out across the
 * reports / commissions / dashboard rep-filter sites. The unit tests assert the emitted SQL *shape*; this
 * EXECUTES the predicate against a faithful deals table (uuid assigned_rep_id + estimator_user_id), so a
 * bad column / cast / coercion fails here instead of in prod. The headline behavior under test:
 *   - filtering by a person surfaces deals they OWN *or* ESTIMATED (estimator-only deals now appear);
 *   - a normal owned-only filter is unchanged;
 *   - the Unassigned sentinel maps to assigned_rep IS NULL ONLY (estimator must NOT widen it);
 *   - the IN-list ("team"/owner) variant surfaces estimator-only deals for any listed person, in all
 *     three cast styles (none / value / column) the call sites use.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP_A = U("a01"); // owns D1; assigned rep of D3 (which REP_B estimated)
const REP_B = U("b01"); // owns D2; estimator-only on D3
const REP_C = U("c01"); // owns nothing, estimated nothing — must surface NO deals
const D = {
  ownedByA: U("d01"),
  ownedByB: U("d02"),
  ownedByA_estByB: U("d03"), // assigned A, estimator B -> the estimator-only-for-B case
  unassigned: U("d04"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
function ids(q: SQL): Promise<string[]> {
  return tdb
    .execute(sql`SELECT d.id::text AS id FROM deals d WHERE ${q} ORDER BY d.id`)
    .then((r: unknown) =>
      ((Array.isArray(r) ? r : (r as { rows?: unknown[] })?.rows ?? []) as Array<{ id: string }>).map((x) => x.id)
    );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (id uuid PRIMARY KEY, assigned_rep_id uuid, estimator_user_id uuid);
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id) VALUES
      ('${D.ownedByA}', '${REP_A}', NULL),
      ('${D.ownedByB}', '${REP_B}', NULL),
      ('${D.ownedByA_estByB}', '${REP_A}', '${REP_B}'),
      ('${D.unassigned}', NULL, NULL);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("buildAliasedInvolvedRepSql — real execution", () => {
  it("filtering by REP_B surfaces deals B owns AND deals B estimated (estimator-only deal appears)", async () => {
    const rows = await ids(buildAliasedInvolvedRepSql("d", REP_B));
    expect(rows).toEqual([D.ownedByB, D.ownedByA_estByB].sort());
  });
  it("filtering by REP_A is unchanged for an owned-only rep (no estimator widening of A's own set)", async () => {
    // A owns D1 and D3; A estimated nothing. So A's set is exactly A's owned deals.
    const rows = await ids(buildAliasedInvolvedRepSql("d", REP_A));
    expect(rows).toEqual([D.ownedByA, D.ownedByA_estByB].sort());
  });
  it("the Unassigned sentinel matches assigned_rep IS NULL ONLY (estimator does not widen it)", async () => {
    const rows = await ids(buildAliasedInvolvedRepSql("d", UNASSIGNED_FILTER_SENTINEL));
    expect(rows).toEqual([D.unassigned]);
  });
  it("a person who neither owns nor estimated anything surfaces NO deals", async () => {
    const rows = await ids(buildAliasedInvolvedRepSql("d", REP_C));
    expect(rows).toEqual([]);
  });
});

describe("buildAliasedInvolvedRepInListSql — real execution (all cast styles)", () => {
  it("a team list [A,B] surfaces every deal either owns or estimated", async () => {
    const rows = await ids(buildAliasedInvolvedRepInListSql("d", [REP_A, REP_B])!);
    expect(rows).toEqual([D.ownedByA, D.ownedByB, D.ownedByA_estByB].sort());
  });
  it("a single-person list [B] surfaces B's owned AND estimated deals (estimator-only appears)", async () => {
    const rows = await ids(buildAliasedInvolvedRepInListSql("d", [REP_B])!);
    expect(rows).toEqual([D.ownedByB, D.ownedByA_estByB].sort());
  });
  it("cast 'value' (::uuid per id) executes and returns the same set", async () => {
    const rows = await ids(buildAliasedInvolvedRepInListSql("d", [REP_B], "value")!);
    expect(rows).toEqual([D.ownedByB, D.ownedByA_estByB].sort());
  });
  it("cast 'column' (::text on both columns) executes and returns the same set", async () => {
    const rows = await ids(buildAliasedInvolvedRepInListSql("d", [REP_B], "column")!);
    expect(rows).toEqual([D.ownedByB, D.ownedByA_estByB].sort());
  });
  it("an empty list returns undefined so the caller omits the clause (never matches the whole table)", () => {
    expect(buildAliasedInvolvedRepInListSql("d", [])).toBeUndefined();
  });
  it("a list of only uninvolved people surfaces NO deals", async () => {
    const rows = await ids(buildAliasedInvolvedRepInListSql("d", [REP_C])!);
    expect(rows).toEqual([]);
  });
});
