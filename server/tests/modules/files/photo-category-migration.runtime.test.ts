import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real SQL execution of migration 0165 against a PGlite instance shaped like a
// prod tenant BEFORE the migration (photo_category enum with only the legacy
// values + a files row already tagged with a legacy value). Proves the migration
// adds the 6 phase values, never drops legacy values, preserves existing data,
// is idempotent, and skips schemas without a photo_category type.
const migrationSql = readFileSync(
  resolve(__dirname, "../../../..", "migrations/0165_photo_phase_categories.sql"),
  "utf8"
);

const LEGACY = ["before", "after", "progress", "site_visit", "damage", "safety", "delivery", "other"];
const NEW = ["estimating", "preconstruction", "construction", "final_completion", "punch", "issues"];

let db: PGlite;

async function enumValues(schema: string): Promise<string[]> {
  const { rows } = await db.query<{ enumlabel: string }>(
    `SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = 'photo_category'
      ORDER BY e.enumsortorder`,
    [schema]
  );
  return rows.map((r) => r.enumlabel);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TYPE office_dallas.photo_category AS ENUM
      ('before','after','progress','site_visit','damage','safety','delivery','other');
    CREATE TABLE office_dallas.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      photo_category office_dallas.photo_category
    );
    INSERT INTO office_dallas.files (photo_category) VALUES ('damage');

    -- A tenant schema with NO photo_category type — the migration must skip it
    -- (the to_regtype guard) without erroring.
    CREATE SCHEMA office_newoffice;
  `);
  await db.exec(migrationSql);
});

afterAll(async () => {
  await db?.close();
});

describe("0165_photo_phase_categories migration", () => {
  it("appends the 6 phase values after the retained legacy values", async () => {
    expect(await enumValues("office_dallas")).toEqual([...LEGACY, ...NEW]);
  });

  it("preserves the pre-existing legacy-tagged photo row", async () => {
    const { rows } = await db.query<{ photo_category: string }>(
      `SELECT photo_category FROM office_dallas.files`
    );
    expect(rows).toEqual([{ photo_category: "damage" }]);
  });

  it("accepts a new phase value on insert", async () => {
    await db.exec(`INSERT INTO office_dallas.files (photo_category) VALUES ('construction')`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM office_dallas.files WHERE photo_category = 'construction'`
    );
    expect(rows[0].n).toBe(1);
  });

  it("still accepts a legacy value on insert (no data destroyed)", async () => {
    await db.exec(`INSERT INTO office_dallas.files (photo_category) VALUES ('safety')`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM office_dallas.files WHERE photo_category = 'safety'`
    );
    expect(rows[0].n).toBe(1);
  });

  it("skips schemas without a photo_category type", async () => {
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT to_regtype('office_newoffice.photo_category') IS NOT NULL AS exists`
    );
    expect(rows[0].exists).toBe(false);
  });

  it("is idempotent on re-run", async () => {
    await db.exec(migrationSql);
    expect(await enumValues("office_dallas")).toEqual([...LEGACY, ...NEW]);
  });
});
