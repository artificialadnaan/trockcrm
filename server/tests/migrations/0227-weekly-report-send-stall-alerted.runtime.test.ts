// Executes migration 0227 FROM DISK against a real Postgres (PGlite).
//
// 0227 adds `weekly_reports.send_stall_alerted_at` — the dead-letter sweep's memory of having already told
// leadership that a delivery stopped moving — to every tenant schema, plus the partial index the sweep
// reads. It is written twice, as every tenant column-add in this repo is: a DO-loop over the existing
// `office_*` schemas, and a `TENANT_SCHEMA_START/END` block the office provisioner replays when a new
// office is created after deploy.
//
// WHICH IS WHY THE TWO HALVES ARE PROVED APART. The DO loop matches `office_dallas` like any other office,
// so a suite that runs the whole migration and then asserts against `office_dallas` stays green with the
// TENANT block deleted — and every office provisioned after that deploy would get 0226's shape, no
// `send_stall_alerted_at`, and a sweep that throws 42703 for that office on every tick while the alerting
// it exists to provide silently never happens there.
//
//   1. The LOOP is proved by a second office schema, which the tenant block does not mention at all.
//   2. The TENANT BLOCK is proved by replaying it alone, with the loop never executed.

import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0227_weekly_report_send_stall_alerted";
const COLUMN = "send_stall_alerted_at";
const INDEX = "weekly_reports_send_unalerted_idx";

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

async function indexDef(schema: string): Promise<string | null> {
  const result = await pg.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    [schema, INDEX],
  );
  return result.rows[0]?.indexdef ?? null;
}

/** The minimum shape 0227 needs: 0222's + 0226's `weekly_reports`, in each of the named office schemas. */
async function seedOffices(schemas: string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.weekly_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        weekly_report_project_id uuid NOT NULL DEFAULT gen_random_uuid(),
        week_of date NOT NULL DEFAULT '2026-08-13',
        status varchar(20) NOT NULL DEFAULT 'sent',
        sent_at timestamptz,
        send_delivered_at timestamptz,
        send_last_attempt_at timestamptz,
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

describe("migration 0227 — send_stall_alerted_at on weekly_reports", () => {
  it("adds the column to EVERY office schema, not just Dallas", async () => {
    // The loop's whole job. In an office missing this column the sweep's SELECT throws 42703 on every
    // tick, and because one office's failure must not stop the others, it fails silently: no alert ever
    // goes out there and nothing but a log line says so.
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await columnType(schema), schema).toBe("timestamp with time zone/YES");
      expect(await indexDef(schema), schema).toContain(COLUMN);
    }
  });

  it("has a TENANT_SCHEMA block that adds the same column and index on its own", async () => {
    // Replayed ALONE, with the loop never run: the only way to tell the two halves apart, and the reason a
    // suite that runs the whole migration cannot. A newly provisioned office gets this block and nothing
    // else.
    await seedOffices(["office_dallas"]);
    expect(await columnType("office_dallas")).toBeNull();
    expect(await indexDef("office_dallas")).toBeNull();

    await pg.exec(tenantBlock());

    expect(await columnType("office_dallas")).toBe("timestamp with time zone/YES");
    expect(await indexDef("office_dallas")).toContain(COLUMN);
  });

  it("indexes only the sends nobody has been told about", async () => {
    // Partial on all four conjuncts. Widen it and the index stops being the tiny in-flight set the sweep
    // reads every fifteen minutes; narrow it wrongly and the sweep's WHERE no longer matches it at all.
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const definition = (await indexDef("office_dallas")) ?? "";
    expect(definition).toContain("is_active");
    // Postgres normalises the varchar comparison to `(status)::text = 'sent'::text` when it reads the
    // definition back, so this is matched loosely rather than as the literal text of the migration.
    expect(definition).toMatch(/status\)?::text = 'sent'/);
    expect(definition).toContain("send_delivered_at IS NULL");
    expect(definition).toContain("send_stall_alerted_at IS NULL");
  });

  it("leaves existing rows NULL, so every undelivered send is still eligible for its first alert", async () => {
    // The safe direction. Back-filling the stamp would mean the deploy that introduces alerting also
    // suppresses it for every send already stuck.
    await seedOffices(["office_dallas"]);
    await pg.exec(
      `INSERT INTO office_dallas.weekly_reports (sent_at) VALUES ('2026-08-13T16:00:00Z'::timestamptz);`,
    );
    await pg.exec(migrationSql(MIGRATION));

    const rows = await pg.query<{ alerted: string | null }>(
      `SELECT ${COLUMN}::text AS alerted FROM office_dallas.weekly_reports`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.alerted).toBeNull();
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
    // Weekly reports arrived in 0222, which itself skips offices without `deals`/`files` — so a schema
    // legitimately without the table exists. An unguarded ALTER there aborts the migration for every
    // office after it in the loop, alphabetically.
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_atlanta;`);
    await seedOffices(["office_dallas"]);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnType("office_dallas")).toBe("timestamp with time zone/YES");
    expect(await columnType("office_atlanta")).toBeNull();
  });
});
