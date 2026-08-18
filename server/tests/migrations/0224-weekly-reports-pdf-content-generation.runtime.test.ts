// Executes migration 0224 FROM DISK against a real Postgres (PGlite).
//
// 0224 adds `weekly_reports.pdf_content_generation` — the content generation a stored PDF was rendered
// from — to every tenant schema. It is written twice, as every tenant column-add in this repo is: a DO-loop
// over the existing `office_*` schemas, and a `TENANT_SCHEMA_START/END` block the office provisioner
// replays when a new office is created after deploy.
//
// Which is exactly why this file exists separately from the feature suite. That suite runs 0222 (whose own
// TENANT block creates `office_dallas`) and then 0224, so `office_dallas` ends up with the column whether
// 0224's loop or its tenant block did the work — deleting EITHER body leaves its assertion green. The two
// halves are only distinguishable by running them apart, which is what the 0220 sibling does and what the
// cases below do:
//
//   1. The LOOP is proved by a second office schema, which the tenant block does not mention at all.
//   2. The TENANT BLOCK is proved by replaying it alone, with the loop never executed.
//
// A schema that carries only one of them is not hypothetical: it is what every office provisioned after
// this deploy would get if the block were dropped, and the failure lands weeks later on the first client
// PDF that office publishes.

import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0224_weekly_reports_pdf_content_generation";
const COLUMN = "pdf_content_generation";

let pg: PGlite;

async function columnType(schema: string): Promise<string | null> {
  const result = await pg.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'weekly_reports' AND column_name = $2`,
    [schema, COLUMN],
  );
  const row = result.rows[0];
  return row ? `${row.data_type}/${row.is_nullable}` : null;
}

/** The minimum shape 0224 needs: a weekly_reports table, in each of the named office schemas. */
async function seedOffices(schemas: string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.weekly_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pdf_r2_key text,
        pdf_generated_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}

/** The block the office provisioner replays, lifted out of the file exactly as the provisioner lifts it. */
function tenantBlock(): string {
  const raw = migrationSql(MIGRATION);
  const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
  expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();
  return block!;
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0224 — pdf_content_generation on weekly_reports", () => {
  it("adds the column to EVERY office schema, not just Dallas", async () => {
    // The loop's whole job. An office missing this column does not degrade: `loadWeeklyReportPdfSource`
    // selects it on every read, so every weekly-report PDF in that office — the CRM download and the
    // client's link alike — fails on the unknown column.
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await columnType(schema), schema).toBe("timestamp with time zone/YES");
    }
  });

  it("has a TENANT_SCHEMA block that adds the same column on its own", async () => {
    // Replayed ALONE, with the loop never run: this is the only way to tell the two halves apart, and the
    // reason a suite that runs the whole migration cannot. A new office gets this block and nothing else.
    await seedOffices(["office_dallas"]);
    expect(await columnType("office_dallas")).toBeNull();

    await pg.exec(tenantBlock());
    expect(await columnType("office_dallas")).toBe("timestamp with time zone/YES");
  });

  it("leaves existing rows NULL, which reads as stale and re-renders once", async () => {
    // The safe direction, and the reason the column is nullable. A report that already has an artifact but
    // no recorded generation cannot be proved current, so it re-renders exactly once — as against
    // back-filling `updated_at` or `pdf_generated_at`, either of which would assert that artifacts made
    // before this migration covered content they were never compared against.
    await seedOffices(["office_dallas"]);
    await pg.exec(`INSERT INTO office_dallas.weekly_reports (pdf_r2_key) VALUES ('legacy/key.pdf');`);
    await pg.exec(migrationSql(MIGRATION));

    const rows = await pg.query<{ generation: string | null }>(
      `SELECT ${COLUMN}::text AS generation FROM office_dallas.weekly_reports`,
    );
    expect(rows.rows[0]?.generation).toBeNull();
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const count = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='weekly_reports' AND column_name=$1`,
      [COLUMN],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("skips an office schema that has no weekly_reports table, instead of failing the whole migration", async () => {
    // Weekly reports arrived in 0222, so a schema created before it — or a partially provisioned one —
    // legitimately has no such table. Without the to_regclass guard the ALTER aborts the migration and
    // takes every later one on the deploy with it.
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnType("office_dallas")).toBe("timestamp with time zone/YES");
  });
});
