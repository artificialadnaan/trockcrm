import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { latestActiveVersionCondition } from "../../../src/modules/files/photo-timeline-filters.js";

/**
 * latestActiveVersionCondition() was rewritten from ONE unindexable COALESCE equality into TWO correlated
 * subqueries, purely so the planner can use an index (it was forcing a Seq Scan of the whole files table
 * on every page of every photo gallery). A performance rewrite of a WHERE clause is only safe if it
 * selects the identical rows, so this suite pins that down against the pre-rewrite expression, kept below
 * as an executable ORACLE rather than as a description in a comment.
 *
 * The fixture is built to make the two spellings disagree if the rewrite is wrong — see FAMILIES. Two
 * cases exist solely as mutation detectors, and both have been confirmed to FAIL when the corresponding
 * half of the new predicate is removed:
 *   - ROOT_NEWER  fails if the family-root subquery is dropped entirely.
 *   - NESTED_MID  fails if `family_root.parent_file_id IS NULL` is dropped from it.
 */

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

/**
 * The predicate as it read BEFORE the rewrite. Equivalence is asserted against this, so it must not be
 * "fixed" or tidied — its whole value is being the old behaviour.
 */
function preRewriteOracleSql() {
  return sql`NOT EXISTS (
    SELECT 1 FROM files f2
    WHERE COALESCE(f2.parent_file_id, f2.id) = COALESCE(files.parent_file_id, files.id)
      AND f2.is_active = true
      AND f2.version > files.version
  )`;
}

// id, parent_file_id, version, is_active — every shape the column definitions permit, not just the shape
// uploadNewVersion happens to write today.
const ROWS: Array<{ id: string; parent: string | null; version: number; active: boolean; note: string }> = [
  // FLAT: the ordinary uploadNewVersion family. Every version points at the ROOT. Latest active = v3.
  { id: U("f001"), parent: null, version: 1, active: true, note: "flat root v1" },
  { id: U("f002"), parent: U("f001"), version: 2, active: true, note: "flat v2 (superseded)" },
  { id: U("f003"), parent: U("f001"), version: 3, active: true, note: "flat v3 (latest)" },

  // FLAT, newest deactivated: the latest ACTIVE member is v2, so v2 is served and the root is not.
  { id: U("d001"), parent: null, version: 1, active: true, note: "deact root v1" },
  { id: U("d002"), parent: U("d001"), version: 2, active: true, note: "deact v2 (latest active)" },
  { id: U("d003"), parent: U("d001"), version: 3, active: false, note: "deact v3 (inactive)" },

  // SOLO: a plain file with no versions. It is its own latest.
  { id: U("5010"), parent: null, version: 1, active: true, note: "solo" },

  // ROOT_NEWER: the root outranks its child. Only reachable through the family-ROOT half of the predicate
  // — the child half looks at rows whose parent_file_id is the key, and the root's is NULL. Drop that half
  // and r002 is wrongly reported as latest.
  { id: U("4001"), parent: null, version: 5, active: true, note: "root v5 (latest)" },
  { id: U("4002"), parent: U("4001"), version: 2, active: true, note: "child v2 (superseded BY ROOT)" },

  // NESTED_MID: a chain root <- mid <- leaf where the MIDDLE node holds the highest version. The old
  // expression does NOT treat mid as the leaf's family (COALESCE(mid.parent, mid.id) resolves to the
  // root, not to mid), so the leaf is latest. Without `family_root.parent_file_id IS NULL` the new
  // predicate would match mid by id and wrongly exclude the leaf.
  { id: U("9001"), parent: null, version: 1, active: true, note: "nested root v1" },
  { id: U("9002"), parent: U("9001"), version: 9, active: true, note: "nested mid v9" },
  { id: U("9003"), parent: U("9002"), version: 3, active: true, note: "nested leaf v3" },

  // TIED: two children on the SAME version. Neither supersedes the other (the predicate is strictly >),
  // so both survive and the root does not.
  { id: U("7001"), parent: null, version: 1, active: true, note: "tied root v1" },
  { id: U("7002"), parent: U("7001"), version: 2, active: true, note: "tied child A v2" },
  { id: U("7003"), parent: U("7001"), version: 2, active: true, note: "tied child B v2" },

  // INACTIVE_NEWER: the only higher version is deactivated, so it supersedes nothing.
  { id: U("6001"), parent: null, version: 1, active: true, note: "inactive-newer root v1" },
  { id: U("6002"), parent: U("6001"), version: 2, active: false, note: "inactive-newer v2" },

  // SELF_PARENT: pathological (parent_file_id = id). Nothing writes it; the schema allows it. Both
  // spellings must agree rather than one of them looping or excluding the row.
  { id: U("3001"), parent: U("3001"), version: 1, active: true, note: "self-parent" },

  // INACTIVE_ROOT with an active child: the root is inactive AND outranked.
  { id: U("2001"), parent: null, version: 1, active: false, note: "inactive root v1" },
  { id: U("2002"), parent: U("2001"), version: 2, active: true, note: "child of inactive root v2" },
];

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      parent_file_id uuid,
      version integer NOT NULL DEFAULT 1,
      is_active boolean NOT NULL DEFAULT true
    );
  `);
  for (const row of ROWS) {
    await pg.exec(
      `INSERT INTO files (id, parent_file_id, version, is_active)
       VALUES ('${row.id}', ${row.parent === null ? "NULL" : `'${row.parent}'`}, ${row.version}, ${row.active})`,
    );
  }
  tdb = drizzle(pg);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

async function idsWhere(predicate: ReturnType<typeof latestActiveVersionCondition>): Promise<string[]> {
  const result = await tdb.execute(
    sql`SELECT id::text AS id FROM files WHERE ${predicate} ORDER BY id`,
  );
  return (((result as any).rows ?? result) as Array<{ id: string }>).map((r) => r.id);
}

describe("latestActiveVersionCondition is equivalent to the pre-rewrite predicate", () => {
  it("selects exactly the same rows as the old COALESCE-equality expression", async () => {
    const [oldIds, newIds] = await Promise.all([
      idsWhere(preRewriteOracleSql()),
      idsWhere(latestActiveVersionCondition()),
    ]);
    // Compared as ordered arrays (both ORDER BY id) so a failure prints which row moved, not just a count.
    expect(newIds).toEqual(oldIds);
    // Guard against the vacuous pass where a bad predicate matches nothing and trivially "agrees".
    expect(newIds.length).toBeGreaterThan(0);
    expect(newIds.length).toBeLessThan(ROWS.length);
  });

  it("keeps only the highest active version of a flat family", async () => {
    const ids = await idsWhere(latestActiveVersionCondition());
    expect(ids).toContain(U("f003")); // v3
    expect(ids).not.toContain(U("f002")); // superseded intermediate
    expect(ids).not.toContain(U("f001")); // superseded root
  });

  it("falls back to the highest ACTIVE version when the newest is deactivated", async () => {
    const ids = await idsWhere(latestActiveVersionCondition());
    expect(ids).toContain(U("d002"));
    expect(ids).not.toContain(U("d001"));
  });

  it("excludes a child that its own family ROOT outranks (needs the family-root half)", async () => {
    const ids = await idsWhere(latestActiveVersionCondition());
    expect(ids).toContain(U("4001")); // root v5 is the latest
    expect(ids).not.toContain(U("4002")); // child v2 is superseded BY the root
  });

  it("does not treat a nested chain's middle node as the leaf's family root", async () => {
    const ids = await idsWhere(latestActiveVersionCondition());
    // mid v9 does not supersede leaf v3: the old expression grouped the leaf under `mid`, whose own
    // COALESCE resolves to the root — so the leaf's family is just itself.
    expect(ids).toContain(U("9003"));
    expect(ids).toContain(U("9002")); // mid v9 outranks root v1
    expect(ids).not.toContain(U("9001"));
  });

  it("treats equal versions as non-superseding", async () => {
    const ids = await idsWhere(latestActiveVersionCondition());
    expect(ids).toContain(U("7002"));
    expect(ids).toContain(U("7003"));
    expect(ids).not.toContain(U("7001"));
  });

  it("ignores a higher version that is deactivated, and tolerates a self-parent row", async () => {
    const ids = await idsWhere(latestActiveVersionCondition());
    expect(ids).toContain(U("6001")); // its only newer sibling is inactive
    expect(ids).toContain(U("3001")); // self-parent: its own family, nothing outranks it
    expect(ids).toContain(U("5010")); // solo
  });
});
