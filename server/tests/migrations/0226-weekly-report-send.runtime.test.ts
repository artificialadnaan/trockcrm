// Executes migration 0226 FROM DISK against a real Postgres (PGlite).
//
// 0226 adds the four `send_*` columns and the undelivered-send partial index to every tenant schema. Like
// every tenant column-add in this repo it is written TWICE: a DO-loop over the existing `office_*` schemas,
// and a `TENANT_SCHEMA_START/END` block the office provisioner replays when a new office is created after
// deploy.
//
// This file exists because the feature suite could not tell those two halves apart. It asserted against
// `office_dallas` — which the DO loop matches (`nspname LIKE 'office\_%'`) AND which is the literal schema
// name hard-coded inside the tenant block — so deleting the ENTIRE `TENANT_SCHEMA_START/END` body left all
// 82 of its tests green. Two independent adversarial reviews confirmed that by deleting the block and
// running the suite. The test was named for exactly the risk it could not measure.
//
// The two halves are only distinguishable by running them APART, which is what the 0220 and 0224 siblings
// do and what the cases below do:
//
//   1. The LOOP is proved by a second office schema, which the tenant block never mentions.
//   2. The TENANT BLOCK is proved by replaying it alone, with the loop never executed.
//   3. The loop's SKIP is proved by an office schema that has no `weekly_reports` at all.
//
// None of this is hypothetical. A schema carrying only one half is what every office provisioned after
// this deploy would get if the block were dropped, and the failure lands on that office's first send —
// `send_request` is written on every one, so sending there fails outright with an unknown column.

import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0226_weekly_report_send";
const COLUMNS = ["send_request", "send_delivery_key", "send_delivered_at", "send_last_attempt_at"];
const INDEX = "weekly_reports_send_undelivered_idx";

let pg: PGlite;

async function columnsOf(schema: string): Promise<string[]> {
  const result = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'weekly_reports'`,
    [schema],
  );
  return result.rows.map((row) => row.column_name);
}

async function hasIndex(schema: string): Promise<boolean> {
  const result = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'weekly_reports'`,
    [schema],
  );
  return result.rows.some((row) => row.indexname === INDEX);
}

/** The minimum shape 0226 needs: 0222's `weekly_reports`, in each of the named office schemas. */
async function seedOffices(schemas: string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.weekly_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        weekly_report_project_id uuid NOT NULL,
        week_of date NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        is_active boolean NOT NULL DEFAULT true
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

describe("migration 0226 — the send columns on weekly_reports", () => {
  it("adds every column to EVERY office schema, not just Dallas", async () => {
    // The loop's whole job. This is the case `office_dallas` alone cannot make: the tenant block names
    // `office_dallas` literally and says nothing about any other office.
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      const columns = await columnsOf(schema);
      for (const column of COLUMNS) {
        expect(columns, `${schema} is missing ${column}`).toContain(column);
      }
      expect(await hasIndex(schema), `${schema} is missing ${INDEX}`).toBe(true);
    }
  });

  it("has a TENANT_SCHEMA block that adds the same columns on its own", async () => {
    // Replayed ALONE, with the loop never run: the only way to tell the two halves apart, and the reason a
    // suite that runs the whole migration cannot. A newly provisioned office gets this block and nothing
    // else. Delete the block and this is the test that goes red.
    await seedOffices(["office_dallas"]);
    expect(await columnsOf("office_dallas")).not.toContain("send_request");

    await pg.exec(tenantBlock());

    const columns = await columnsOf("office_dallas");
    for (const column of COLUMNS) {
      expect(columns, `tenant block did not add ${column}`).toContain(column);
    }
    expect(await hasIndex("office_dallas"), `tenant block did not create ${INDEX}`).toBe(true);
  });

  it("SKIPS an office that has no weekly_reports rather than aborting the whole migration", async () => {
    // The `IF to_regclass(...) IS NULL THEN CONTINUE` arm. 0222 itself skips offices lacking `deals`/
    // `files`, so an office schema without `weekly_reports` is a real state — and an ALTER against a table
    // that was never created there would abort the migration for EVERY office ordered after it, not just
    // that one. With a single well-formed office in the fixture, removing the skip changes nothing.
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    // The control: the well-formed office beside it still got everything.
    expect(await columnsOf("office_dallas")).toContain("send_request");
    expect(await hasIndex("office_dallas")).toBe(true);
  });

  it("is replayable — running it a second time is a no-op, not an error", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
  });

  it("builds the undelivered index PARTIAL, so it stays small", async () => {
    // The point of the index is that in steady state it holds only the handful of sends in flight. A
    // non-partial index over every weekly report would still satisfy a "does the index exist" assertion.
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const result = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'office_dallas' AND indexname = $1`,
      [INDEX],
    );
    expect(result.rows[0]?.indexdef).toMatch(/WHERE/i);
    expect(result.rows[0]?.indexdef).toMatch(/send_delivered_at IS NULL/i);
  });
});
