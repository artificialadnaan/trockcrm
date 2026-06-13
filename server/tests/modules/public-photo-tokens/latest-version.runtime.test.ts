import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { latestActivePhotoSql } from "../../../src/modules/public-photo-tokens/service.js";

/**
 * REAL-SQL (PGlite) proof that the public-share serve-time latest-version predicate is the version-FAMILY
 * check, not the old `parent_file_id = files.id` child check. uploadNewVersion stores EVERY version with
 * parent_file_id = ROOT id (flat family), so the old predicate only excluded the root — an intermediate v2
 * (nothing points at it) wrongly read as "latest" once v3 existed, and a direct/cached subset-share URL
 * kept serving the superseded v2. This exercises latestActivePhotoSql() against a real `files` table.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;

// Family 1: root(v1) <- v2 <- v3, all active. Latest = v3 only.
const F1_ROOT = U("f101"), F1_V2 = U("f102"), F1_V3 = U("f103");
// Family 2: root(v1) <- v2 <- v3, but v3 deactivated. Latest active = v2.
const F2_ROOT = U("f201"), F2_V2 = U("f202"), F2_V3 = U("f203");
// Solo: a single root with no versions. It is its own latest.
const SOLO = U("f301");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      parent_file_id uuid,
      version integer NOT NULL DEFAULT 1,
      is_active boolean NOT NULL DEFAULT true
    );
    -- All versions point at the ROOT (flat family), matching uploadNewVersion.
    INSERT INTO files (id, parent_file_id, version, is_active) VALUES
      ('${F1_ROOT}', NULL,        1, true),
      ('${F1_V2}',   '${F1_ROOT}', 2, true),
      ('${F1_V3}',   '${F1_ROOT}', 3, true),
      ('${F2_ROOT}', NULL,        1, true),
      ('${F2_V2}',   '${F2_ROOT}', 2, true),
      ('${F2_V3}',   '${F2_ROOT}', 3, false),  -- latest deactivated
      ('${SOLO}',    NULL,        1, true);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

async function latestIds(): Promise<string[]> {
  const r = await tdb.execute(sql`SELECT id::text AS id FROM files WHERE true ${latestActivePhotoSql()} ORDER BY id`);
  return (((r as any).rows ?? r) as Array<{ id: string }>).map((x) => x.id);
}

describe("latestActivePhotoSql (public-share serve-time eligibility)", () => {
  it("returns only the highest-version active member of each flat version family", async () => {
    const ids = await latestIds();
    // F1: only v3 (root + v2 excluded). F2: v2 (v3 inactive, root excluded). SOLO: itself.
    expect(ids).toEqual([F1_V3, F2_V2, SOLO].sort());
  });

  it("excludes a superseded NON-ROOT version (the bug): v2 is not served once active v3 exists", async () => {
    const ids = await latestIds();
    expect(ids).not.toContain(F1_V2); // the regression the old `parent_file_id = files.id` predicate missed
    expect(ids).not.toContain(F1_ROOT);
    expect(ids).toContain(F1_V3);
  });

  it("falls back to the highest ACTIVE version when the newest is deactivated", async () => {
    const ids = await latestIds();
    expect(ids).toContain(F2_V2);
    expect(ids).not.toContain(F2_V3); // inactive
    expect(ids).not.toContain(F2_ROOT); // superseded
  });
});
