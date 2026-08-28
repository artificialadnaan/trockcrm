// Executes migration 0242 from disk. This suite proves both rollout generations: existing office tables
// are repaired by the all-office loop, while an office provisioned later receives the same trigger and
// constraint shape from TENANT_SCHEMA. The trigger cases deliberately omit the new column, matching an
// older API container that is still serving during rollout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0242_weekly_report_delivery_recorded_at";
const COLUMN = "send_delivery_status_recorded_at";
const CHECK = "weekly_reports_send_delivery_recorded_pair_check";
const TRIGGERS = [
  "weekly_reports_delivery_boundary_insert_stmt",
  "weekly_reports_delivery_boundary_update_stmt",
  "weekly_reports_delivery_recorded_row",
] as const;

let pg: PGlite;

async function seedOffice(schema: string): Promise<void> {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE ${schema}.weekly_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      send_delivery_status text,
      send_delivery_status_at timestamptz,
      send_delivery_detail jsonb
    );
  `);
}

async function columnType(schema: string): Promise<string | null> {
  const result = await pg.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'weekly_reports' AND column_name = $2`,
    [schema, COLUMN],
  );
  return result.rows[0]?.data_type ?? null;
}

async function triggerNames(schema: string): Promise<string[]> {
  const result = await pg.query<{ tgname: string }>(
    `SELECT tg.tgname
       FROM pg_trigger tg
       JOIN pg_class t ON t.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'weekly_reports' AND NOT tg.tgisinternal
      ORDER BY tg.tgname`,
    [schema],
  );
  return result.rows.map((row) => row.tgname);
}

function tenantBlock(forSchema: string): string {
  const raw = migrationSql(MIGRATION);
  const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
  expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();
  return block!.replace(/office_dallas/g, forSchema);
}

beforeEach(async () => {
  pg = new PGlite();
});

afterEach(async () => {
  await pg.close();
});

describe("migration 0242 — CRM receipt boundary for delivery verdicts", () => {
  it("adds and backfills the paired receipt clock in every existing office", async () => {
    await seedOffice("office_dallas");
    await seedOffice("office_atlanta");
    for (const schema of ["office_dallas", "office_atlanta"]) {
      await pg.exec(
        `INSERT INTO ${schema}.weekly_reports
           (send_delivery_status, send_delivery_status_at, send_delivery_detail)
         VALUES ('bounced', '2026-08-01T00:00:00Z', '{"source":"old image"}')`,
      );
    }

    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await columnType(schema)).toBe("timestamp with time zone");
      expect(await triggerNames(schema)).toEqual([...TRIGGERS].sort());
      const row = await pg.query<{ recorded_at: Date | string | null }>(
        `SELECT send_delivery_status_recorded_at AS recorded_at FROM ${schema}.weekly_reports`,
      );
      expect(row.rows[0]?.recorded_at).not.toBeNull();
      const constraint = await pg.query<{ validated: boolean }>(
        `SELECT c.convalidated AS validated
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'weekly_reports' AND c.conname = $2`,
        [schema, CHECK],
      );
      expect(constraint.rows).toEqual([{ validated: true }]);
    }
  });

  it("stamps an old-image verdict write, preserves first-known failure time, and clears on reset", async () => {
    await seedOffice("office_dallas");
    await pg.exec(migrationSql(MIGRATION));
    await pg.exec(`
      INSERT INTO office_dallas.weekly_reports
        (send_delivery_status, send_delivery_status_at, send_delivery_detail)
      VALUES ('bounced', '2026-08-01T00:00:00Z', '{"class":"soft"}');
    `);
    const first = await pg.query<{ id: string; recorded_at: Date | string }>(
      `SELECT id, send_delivery_status_recorded_at AS recorded_at
         FROM office_dallas.weekly_reports`,
    );
    const firstStamp = new Date(first.rows[0]!.recorded_at).toISOString();

    // Exactly the columns an old container knows: no explicit receipt timestamp.
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_delivery_status = 'failed',
              send_delivery_status_at = '2026-08-02T00:00:00Z',
              send_delivery_detail = '{"class":"refined"}'
        WHERE id = $1::uuid`,
      [first.rows[0]!.id],
    );
    const refined = await pg.query<{ recorded_at: Date | string }>(
      `SELECT send_delivery_status_recorded_at AS recorded_at
         FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [first.rows[0]!.id],
    );
    expect(new Date(refined.rows[0]!.recorded_at).toISOString()).toBe(firstStamp);

    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_delivery_status = NULL,
              send_delivery_status_at = NULL,
              send_delivery_detail = NULL
        WHERE id = $1::uuid`,
      [first.rows[0]!.id],
    );
    const reset = await pg.query<{ status: string | null; recorded_at: Date | string | null }>(
      `SELECT send_delivery_status AS status, send_delivery_status_recorded_at AS recorded_at
         FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [first.rows[0]!.id],
    );
    expect(reset.rows[0]).toEqual({ status: null, recorded_at: null });
  });

  it("gives a newly provisioned office the complete trigger/constraint shape", async () => {
    await seedOffice("office_dallas");
    await pg.exec(migrationSql(MIGRATION));
    await seedOffice("office_houston");
    await pg.exec(tenantBlock("office_houston"));

    expect(await columnType("office_houston")).toBe("timestamp with time zone");
    expect(await triggerNames("office_houston")).toEqual([...TRIGGERS].sort());
    await pg.exec(
      `INSERT INTO office_houston.weekly_reports (send_delivery_status)
       VALUES ('failed'), (NULL)`,
    );
    const rows = await pg.query<{ status: string | null; paired: boolean }>(
      `SELECT send_delivery_status AS status,
              ((send_delivery_status IS NULL) =
               (send_delivery_status_recorded_at IS NULL)) AS paired
         FROM office_houston.weekly_reports ORDER BY status NULLS LAST`,
    );
    expect(rows.rows).toEqual([
      { status: "failed", paired: true },
      { status: null, paired: true },
    ]);
  });

  it("is idempotent and keeps the database-owned pair constraint enforceable", async () => {
    await seedOffice("office_dallas");
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await triggerNames("office_dallas")).toEqual([...TRIGGERS].sort());

    await pg.exec("ALTER TABLE office_dallas.weekly_reports DISABLE TRIGGER weekly_reports_delivery_recorded_row");
    await expect(
      pg.exec(
        `INSERT INTO office_dallas.weekly_reports
           (send_delivery_status, send_delivery_status_recorded_at)
         VALUES ('failed', NULL)`,
      ),
    ).rejects.toThrow(/weekly_reports_send_delivery_recorded_pair_check/);
  });
});
