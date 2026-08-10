// Executes migration 0220 FROM DISK against a real Postgres (PGlite).
//
// 0220 adds `created_by_user_id` to companies/properties/contacts in every tenant schema. Two properties are
// worth proving rather than assuming:
//
//   1. It touches EVERY office schema, not just office_dallas. A tenant column-add that misses a schema
//      breaks every directory create in that office at runtime, on the unknown column.
//   2. The TENANT_SCHEMA_START/END block matches the loop. The office provisioner replays only that block
//      when a new office is created after deploy, so a block that drifts from the loop leaves new offices
//      silently missing the column — the failure lands weeks later, on the first office anyone adds.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0220_directory_created_by_user";
const TABLES = ["companies", "properties", "contacts"] as const;

let pg: PGlite;

async function columnExists(schema: string, table: string, column: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

/** The minimum shape 0220 needs: the four directory tables, in each of two offices. */
async function seedOffices(schemas: string[]) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.companies  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE ${schema}.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE ${schema}.contacts   (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE ${schema}.leads      (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    `);
  }
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0220 — created_by_user_id on the directory tables", () => {
  it("adds the column to EVERY office schema, not just the first", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      for (const table of TABLES) {
        expect(await columnExists(schema, table, "created_by_user_id"), `${schema}.${table}`).toBe(true);
      }
    }
  });

  it("leaves the column NULLABLE and backfills nothing — history was never recorded", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`INSERT INTO office_dallas.companies DEFAULT VALUES;`);
    await pg.exec(migrationSql(MIGRATION));

    const nullable = await pg.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='companies' AND column_name='created_by_user_id'`
    );
    expect(nullable.rows[0]?.is_nullable).toBe("YES");

    // The pre-existing row must stay unattributed rather than being credited to anyone.
    const row = await pg.query<{ creator: string | null }>(
      `SELECT created_by_user_id::text AS creator FROM office_dallas.companies`
    );
    expect(row.rows[0]?.creator).toBeNull();
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const count = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='companies' AND column_name='created_by_user_id'`
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("skips a schema that does not have the tables, instead of failing the whole migration", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnExists("office_dallas", "companies", "created_by_user_id")).toBe(true);
  });

  // Indexed on created_at, not on (creator, created_at) and not partial: the report's scan deliberately
  // includes null-creator rows to count what it cannot attribute, so a partial index on a non-null creator
  // could never serve it, and the column it actually filters on is the date.
  it("creates a created_at index on all four tables, including leads", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const result = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='office_dallas' AND indexname LIKE '%_created_at_idx' ORDER BY indexname`
    );
    expect(result.rows.map((r) => r.indexname)).toEqual([
      "companies_created_at_idx",
      "contacts_created_at_idx",
      "leads_created_at_idx",
      "properties_created_at_idx",
    ]);
    for (const row of result.rows) {
      expect(row.indexdef, row.indexname).not.toContain("WHERE");
      expect(row.indexdef, row.indexname).toContain("created_at");
    }
  });

  // The provisioner replays ONLY the marked block for offices created after this deploy. If it drifts from
  // the loop, a new office comes up missing the column and every directory create there 500s.
  it("has a TENANT_SCHEMA block that produces the same columns and indexes as the loop", async () => {
    const raw = migrationSql(MIGRATION);
    const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
    expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();

    // Replay the block alone against a fresh schema standing in for a newly provisioned office, exactly
    // as the provisioner does (office_dallas -> the new schema).
    await seedOffices(["office_dallas"]);
    await pg.exec(block!);

    for (const table of TABLES) {
      expect(await columnExists("office_dallas", table, "created_by_user_id"), table).toBe(true);
    }
    const indexes = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='office_dallas' AND indexname LIKE '%_created_at_idx'`
    );
    expect(indexes.rows).toHaveLength(4);
  });
});
