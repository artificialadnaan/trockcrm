// Executes migration 0239 FROM DISK against a real Postgres (PGlite).
//
// 0239 adds `tasks.assigned_at` — when the task last changed hands — which is what lets an
// acknowledgement answer ONE assignment rather than a task forever.
//
// THE FILE ADDS THE COLUMN AND NOTHING ELSE. Dating the existing rows is a runner step
// (server/src/migrations/tasks-assigned-at-backfill.ts, covered by its own suite) because the backfill
// must disable set_tasks_updated_at and audit_tasks around itself, and `ALTER TABLE ... DISABLE
// TRIGGER` takes a lock that conflicts with every task write. runner.ts sends each .sql as ONE
// client.query(), so a DO block looping offices here would hold the first office's lock until the last
// one finished — task writes blocking across every tenant during API startup. That the file contains
// no backfill is asserted below, not just assumed: putting one back is the regression this file half
// has to prevent, and it would look perfectly reasonable in a diff.
//
// THREE offices, because office_dallas is ALSO written by the literal tenant block at the foot of the
// file and so comes out correct even with the loop broken. A third office has no second source.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0239_tasks_assigned_at";
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

/** The moment every seeded row was last touched. Any trigger firing during the backfill moves this. */
const SEEDED_UPDATED_AT = "2020-01-02 03:04:05+00";
const SEEDED_CREATED_AT = "2019-06-07 08:09:10+00";

let pg: PGlite;

async function seedOffices(schemas: readonly string[]) {
  await pg.exec(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $fn$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $fn$ LANGUAGE plpgsql;

    CREATE TABLE IF NOT EXISTS public.audit_log_probe (id bigserial PRIMARY KEY, action text NOT NULL);

    CREATE OR REPLACE FUNCTION audit_trigger_probe() RETURNS TRIGGER AS $fn$
    BEGIN INSERT INTO public.audit_log_probe (action) VALUES (TG_OP); RETURN NEW; END;
    $fn$ LANGUAGE plpgsql;
  `);

  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(500) NOT NULL,
        assigned_to uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TRIGGER set_tasks_updated_at
        BEFORE UPDATE ON ${schema}.tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      CREATE TRIGGER audit_tasks
        AFTER INSERT OR UPDATE OR DELETE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION audit_trigger_probe();

      INSERT INTO ${schema}.tasks (title, created_at, updated_at)
        VALUES ('historic task', '${SEEDED_CREATED_AT}', '${SEEDED_UPDATED_AT}');
    `);
    await pg.exec(`DELETE FROM public.audit_log_probe;`);
  }
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0239 — tasks.assigned_at", () => {
  it("adds the column to EVERY office schema, not just the first", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const result = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'assigned_at'`,
        [schema]
      );
      expect(result.rows[0]?.n, schema).toBe(1);
    }
  });

  it("adds the column with a default, so a worker on the old image can still INSERT", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      // The API runs migrations and the worker does not, and they are separate Railway services. A
      // NOT NULL column with no default would fail every rules-engine write during the deploy window.
      await expect(
        pg.exec(`INSERT INTO ${schema}.tasks (title) VALUES ('written by an old worker')`),
        schema
      ).resolves.toBeDefined();
    }
  });

  // THE BACKFILL MUST NOT COME BACK. Restoring it to the file would restore the cross-tenant lock hold
  // this PR moved it out to avoid, and it would read as a perfectly ordinary DO block in review.
  it("contains no backfill and no trigger juggling — both belong to the runner step", async () => {
    const source = migrationSql(MIGRATION);

    expect(source, "an UPDATE here runs inside one transaction spanning every office").not.toMatch(
      /UPDATE\s+%1\$I\.tasks/
    );
    expect(source).not.toContain("DISABLE TRIGGER");
    expect(source).not.toContain("ENABLE TRIGGER");
  });

  it("leaves updated_at alone, because it writes no rows at all", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const result = await pg.query<{ updated_at: string }>(
        `SELECT updated_at::text FROM ${schema}.tasks`
      );
      expect(result.rows[0]?.updated_at, schema).toContain("2020-01-02");
    }
  });

  it("writes no audit rows", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    const result = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.audit_log_probe`);
    expect(result.rows[0]?.n).toBe(0);
  });

  it("is idempotent — a second run neither errors nor touches a row", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    for (const schema of OFFICES) {
      const result = await pg.query<{ updated_at: string }>(
        `SELECT updated_at::text FROM ${schema}.tasks`
      );
      expect(result.rows[0]?.updated_at, schema).toContain("2020-01-02");
    }
  });

  it("carries a tenant block that provisions a brand-new office schema", async () => {
    const source = migrationSql(MIGRATION);
    const startIdx = source.indexOf("-- TENANT_SCHEMA_START");
    const endIdx = source.indexOf("-- TENANT_SCHEMA_END");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    // The provisioner takes the FIRST occurrence, so a prose mention above the real block would hand
    // every new office a fragment of a comment instead of DDL.
    expect(source.indexOf("-- TENANT_SCHEMA_START", startIdx + 1)).toBe(-1);

    const block = source.slice(startIdx + "-- TENANT_SCHEMA_START".length, endIdx).trim();
    await seedOffices(["office_tulsa"]);
    await pg.exec(block.replace(/office_dallas/g, "office_tulsa"));

    const result = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'office_tulsa' AND table_name = 'tasks' AND column_name = 'assigned_at'`
    );
    expect(result.rows[0]?.n).toBe(1);
  });

  it("skips an office schema that has no tasks table instead of aborting the deploy", async () => {
    await seedOffices(OFFICES);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_halfbuilt;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
  });
});
