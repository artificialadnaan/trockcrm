// Executes migration 0242 from disk. This suite proves both rollout generations: existing office tables
// are repaired by the one-transaction-per-office runner, while an office provisioned later receives the
// same trigger and constraint shape from TENANT_SCHEMA. The trigger cases deliberately omit the new
// receipt column, matching an older API container that is still serving during rollout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";
import {
  WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION,
  runWeeklyReportDeliveryRecordedAtMigration,
} from "../../src/migrations/weekly-report-delivery-recorded-at.js";

const MIGRATION = "0242_weekly_report_delivery_recorded_at";
const ACCEPTANCE_COLUMN = "send_acceptance_recorded_at";
const VERDICT_COLUMN = "send_delivery_status_recorded_at";
const ACCEPTANCE_CHECK = "weekly_reports_send_acceptance_recorded_pair_check";
const VERDICT_CHECK = "weekly_reports_send_delivery_recorded_pair_check";
const TRIGGERS = [
  "weekly_reports_delivery_boundary_acceptance_update_stmt",
  "weekly_reports_delivery_boundary_insert_stmt",
  "weekly_reports_delivery_boundary_verdict_update_stmt",
  "weekly_reports_delivery_recorded_row",
] as const;

let pg: PGlite;

const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/migrations/runner.ts");
const runnerSource = readFileSync(runnerPath, "utf8");

async function applyMigration(): Promise<void> {
  const client = {
    query: async (statement: string, params?: unknown[]) => {
      // node-postgres sends parameter-free migration batches over the simple-query protocol. PGlite's
      // `query` method always chooses its prepared-statement path and refuses multiple commands, while
      // `exec` models the simple protocol. Keep catalog reads parameterized and use exec only for the two
      // batches the production runner sends without parameters.
      if (
        params === undefined &&
        (statement.includes("CREATE OR REPLACE FUNCTION public.weekly_report_delivery_boundary_lock_v1") ||
          statement.includes("ALTER TABLE office_"))
      ) {
        await pg.exec(statement);
        return { rows: [] };
      }
      return pg.query(statement, params as never);
    },
  };
  await runWeeklyReportDeliveryRecordedAtMigration(
    client as unknown as Parameters<typeof runWeeklyReportDeliveryRecordedAtMigration>[0],
    migrationSql(MIGRATION),
  );
}

async function seedOffice(schema: string): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.offices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      slug text NOT NULL UNIQUE
    );
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE ${schema}.weekly_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      send_delivered_at timestamptz,
      send_delivery_status text,
      send_delivery_status_at timestamptz,
      send_delivery_detail jsonb
    );
  `);
}

async function columnType(schema: string, column: string): Promise<string | null> {
  const result = await pg.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'weekly_reports' AND column_name = $2`,
    [schema, column],
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
  it("adds and backfills both paired receipt clocks in every existing office", async () => {
    await seedOffice("office_dallas");
    await seedOffice("office_atlanta");
    for (const schema of ["office_dallas", "office_atlanta"]) {
      await pg.exec(
        `INSERT INTO ${schema}.weekly_reports
           (send_delivered_at, send_delivery_status, send_delivery_status_at, send_delivery_detail)
         VALUES ('2026-07-31T23:00:00Z', 'bounced', '2026-08-01T00:00:00Z',
                 '{"source":"old image"}')`,
      );
    }

    await applyMigration();

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await columnType(schema, ACCEPTANCE_COLUMN)).toBe("timestamp with time zone");
      expect(await columnType(schema, VERDICT_COLUMN)).toBe("timestamp with time zone");
      expect(await triggerNames(schema)).toEqual([...TRIGGERS].sort());
      const row = await pg.query<{
        acceptance_recorded_at: Date | string | null;
        verdict_recorded_at: Date | string | null;
      }>(
        `SELECT send_acceptance_recorded_at AS acceptance_recorded_at,
                send_delivery_status_recorded_at AS verdict_recorded_at
           FROM ${schema}.weekly_reports`,
      );
      expect(row.rows[0]?.acceptance_recorded_at).not.toBeNull();
      expect(row.rows[0]?.verdict_recorded_at).not.toBeNull();
      const constraint = await pg.query<{ validated: boolean }>(
        `SELECT c.convalidated AS validated
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'weekly_reports' AND c.conname = $2`,
        [schema, ACCEPTANCE_CHECK],
      );
      expect(constraint.rows).toEqual([{ validated: true }]);
      const verdictConstraint = await pg.query<{ validated: boolean }>(
        `SELECT c.convalidated AS validated
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'weekly_reports' AND c.conname = $2`,
        [schema, VERDICT_CHECK],
      );
      expect(verdictConstraint.rows).toEqual([{ validated: true }]);
    }
  });

  it("stamps an old-image verdict write, preserves first-known failure time, and clears on reset", async () => {
    await seedOffice("office_dallas");
    await applyMigration();
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
    await applyMigration();
    await seedOffice("office_houston");
    await pg.exec(tenantBlock("office_houston"));

    expect(await columnType("office_houston", ACCEPTANCE_COLUMN)).toBe("timestamp with time zone");
    expect(await columnType("office_houston", VERDICT_COLUMN)).toBe("timestamp with time zone");
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
    await applyMigration();
    await expect(applyMigration()).resolves.toBeUndefined();
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

  it("owns the live acceptance clocks and stamps historical imports after their publication boundary", async () => {
    await seedOffice("office_dallas");
    await applyMigration();
    const definitions = await pg.query<{ tgname: string; definition: string }>(
      `SELECT tg.tgname, pg_get_triggerdef(tg.oid) AS definition
         FROM pg_trigger tg
         JOIN pg_class t ON t.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'office_dallas'
          AND t.relname = 'weekly_reports'
          AND tg.tgname IN (
            'weekly_reports_delivery_boundary_acceptance_update_stmt',
            'weekly_reports_delivery_recorded_row'
          )`,
    );
    for (const trigger of definitions.rows) {
      expect(trigger.definition).toContain("send_delivered_at");
    }
    expect(definitions.rows.map((row) => row.tgname).sort()).toEqual([
      "weekly_reports_delivery_boundary_acceptance_update_stmt",
      "weekly_reports_delivery_recorded_row",
    ]);
    const inserted = await pg.query<{ id: string }>(
      `INSERT INTO office_dallas.weekly_reports DEFAULT VALUES RETURNING id`,
    );
    const workerTransactionStartedAt = "2000-01-01T00:00:00.000Z";

    // An old worker uses NOW(), which can retain a transaction-start time from before page one. The DB
    // trigger must replace that supplied value only after the statement-level advisory lock is held.
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_delivered_at = $2::timestamptz
        WHERE id = $1::uuid`,
      [inserted.rows[0]!.id, workerTransactionStartedAt],
    );
    const accepted = await pg.query<{ accepted_at: Date | string; recorded_at: Date | string }>(
      `SELECT send_delivered_at AS accepted_at,
              send_acceptance_recorded_at AS recorded_at
         FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [inserted.rows[0]!.id],
    );
    expect(new Date(accepted.rows[0]!.accepted_at).toISOString()).not.toBe(
      workerTransactionStartedAt,
    );
    expect(new Date(accepted.rows[0]!.recorded_at).toISOString()).toBe(
      new Date(accepted.rows[0]!.accepted_at).toISOString(),
    );

    // Once published, an unrelated/incorrect timestamp edit cannot move the row across an issued walk.
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_delivered_at = '1999-01-01T00:00:00Z'::timestamptz
        WHERE id = $1::uuid`,
      [inserted.rows[0]!.id],
    );
    const preserved = await pg.query<{ accepted_at: Date | string }>(
      `SELECT send_delivered_at AS accepted_at
         FROM office_dallas.weekly_reports WHERE id = $1::uuid`,
      [inserted.rows[0]!.id],
    );
    expect(new Date(preserved.rows[0]!.accepted_at).toISOString()).toBe(
      new Date(accepted.rows[0]!.accepted_at).toISOString(),
    );

    const beforeImport = await pg.query<{ boundary: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary`,
    );
    await pg.exec("SELECT pg_sleep(0.005)");
    const imported = await pg.query<{
      accepted_at: Date | string;
      recorded_at: Date | string;
    }>(
      `INSERT INTO office_dallas.weekly_reports (send_delivered_at)
       VALUES ('2001-02-03T04:05:06Z'::timestamptz)
       RETURNING send_delivered_at AS accepted_at,
                 send_acceptance_recorded_at AS recorded_at`,
    );
    expect(new Date(imported.rows[0]!.accepted_at).toISOString()).toBe(
      "2001-02-03T04:05:06.000Z",
    );
    expect(new Date(imported.rows[0]!.recorded_at).getTime()).toBeGreaterThan(
      Date.parse(beforeImport.rows[0]!.boundary),
    );
  });

  it("uses a retryable verdict lock so old row-first webhooks cannot deadlock boundary-first writers", async () => {
    await seedOffice("office_dallas");
    await applyMigration();
    const definitions = await pg.query<{ tgname: string; definition: string }>(
      `SELECT tg.tgname, pg_get_triggerdef(tg.oid) AS definition
         FROM pg_trigger tg
         JOIN pg_class t ON t.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'office_dallas'
          AND t.relname = 'weekly_reports'
          AND tg.tgname LIKE 'weekly_reports_delivery_boundary_%_update_stmt'
        ORDER BY tg.tgname`,
    );
    expect(definitions.rows).toEqual([
      expect.objectContaining({
        tgname: "weekly_reports_delivery_boundary_acceptance_update_stmt",
        definition: expect.stringContaining("weekly_report_delivery_boundary_lock_v1"),
      }),
      expect.objectContaining({
        tgname: "weekly_reports_delivery_boundary_verdict_update_stmt",
        definition: expect.stringContaining("weekly_report_delivery_boundary_try_lock_v1"),
      }),
    ]);
    expect(migrationSql(MIGRATION)).toContain("USING ERRCODE = '40001'");
  });

  it("repairs an office committed by an old provisioner after the existing-office scan began", async () => {
    await seedOffice("office_dallas");
    await applyMigration();

    await pg.exec(`
      BEGIN;
      INSERT INTO public.offices (name, slug) VALUES ('Houston', 'houston');
      CREATE SCHEMA office_houston;
      CREATE TABLE office_houston.weekly_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        send_delivered_at timestamptz,
        send_delivery_status text,
        send_delivery_status_at timestamptz,
        send_delivery_detail jsonb
      );
      COMMIT;
    `);

    expect(await columnType("office_houston", ACCEPTANCE_COLUMN)).toBe("timestamp with time zone");
    expect(await columnType("office_houston", VERDICT_COLUMN)).toBe("timestamp with time zone");
    expect(await triggerNames("office_houston")).toEqual([...TRIGGERS].sort());
  });

  it("serializes 0242's per-office commits through its ledger write", () => {
    const branch = runnerSource.indexOf(
      "file === WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION",
    );
    const wrapper = runnerSource.indexOf(
      "async function runWeeklyReportDeliveryRecordedAtMigrationUnderLock",
    );
    const lock = runnerSource.indexOf(
      "WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION_LOCK",
      wrapper,
    );
    const recheck = runnerSource.indexOf(
      '"SELECT id FROM public._migrations WHERE name = $1"',
      lock,
    );
    const run = runnerSource.indexOf(
      "await runWeeklyReportDeliveryRecordedAtMigration(client, sql)",
      recheck,
    );
    const ledger = runnerSource.indexOf(
      '"INSERT INTO public._migrations (name) VALUES ($1)"',
      run,
    );
    const unlock = runnerSource.indexOf(
      "pg_advisory_unlock",
      ledger,
    );
    const wrapperCall = runnerSource.indexOf(
      "runWeeklyReportDeliveryRecordedAtMigrationUnderLock(client, file)",
      branch,
    );
    const sql = migrationSql(MIGRATION);
    const existingTenantSection = sql.slice(0, sql.indexOf("-- TENANT_SCHEMA_START"));

    expect(WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION).toBe(
      "0242_weekly_report_delivery_recorded_at.sql",
    );
    expect(branch).toBeGreaterThan(-1);
    expect(wrapper).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(wrapper);
    expect(recheck).toBeGreaterThan(lock);
    expect(run).toBeGreaterThan(recheck);
    expect(ledger).toBeGreaterThan(run);
    expect(unlock).toBeGreaterThan(ledger);
    expect(wrapperCall).toBeGreaterThan(branch);
    expect(existingTenantSection).not.toContain("DO $tenant$");
    expect(existingTenantSection).not.toContain("UPDATE office_");
  });

  it("commits one complete office cutover before beginning the next", async () => {
    const calls: Array<{ statement: string; params: unknown[] | undefined }> = [];
    const query = async (statement: string, params?: unknown[]) => {
      calls.push({ statement, params });
      if (statement.includes("FROM information_schema.schemata")) {
        return { rows: [{ schema_name: "office_atlanta" }, { schema_name: "office_dallas" }] };
      }
      if (statement.includes("SELECT COUNT(*)::int AS n")) {
        return { rows: [{ n: 1 }] };
      }
      return { rows: [] };
    };

    await runWeeklyReportDeliveryRecordedAtMigration(
      { query } as never,
      migrationSql(MIGRATION),
    );

    const transactionSequence = calls
      .map(({ statement }) => statement)
      .filter(
        (statement) =>
          statement === "BEGIN" ||
          statement === "COMMIT" ||
          statement.includes("install_weekly_report_delivery_boundary_v1('office_atlanta')") ||
          statement.includes("install_weekly_report_delivery_boundary_v1('office_dallas')"),
      )
      .map((statement) => {
        if (statement === "BEGIN" || statement === "COMMIT") return statement;
        return statement.includes("office_atlanta") ? "ATLANTA_STEP" : "DALLAS_STEP";
      });

    expect(transactionSequence).toEqual([
      "BEGIN",
      "ATLANTA_STEP",
      "COMMIT",
      "BEGIN",
      "DALLAS_STEP",
      "COMMIT",
    ]);
  });
});
