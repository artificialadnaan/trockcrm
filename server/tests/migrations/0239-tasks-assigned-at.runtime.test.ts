// Executes migration 0239 FROM DISK against a real Postgres (PGlite).
//
// 0239 adds `tasks.assigned_at` — when the task last changed hands — which is what lets an
// acknowledgement answer ONE assignment rather than a task forever.
//
// Two properties carry the risk, and neither is visible by reading the file:
//
//   1. THE BACKFILL MUST DATE FROM created_at, NOT now(). History does not record when a task changed
//      hands, so any value is a guess and the DIRECTION of the guess is the whole decision. Too early
//      is safe: an existing acknowledgement still covers the assignment and nothing pops. now() would
//      post-date every acknowledgement in the table at a stroke and re-notify the entire company about
//      work they have already seen — the same failure 0235's own seed exists to prevent, reintroduced
//      by its neighbour.
//   2. THE UPDATED_AT TRIGGER MUST NOT FIRE. `tasks` carries set_tasks_updated_at, and the contacts
//      list reads MAX(tasks.updated_at) straight through as a contact's "Last touch" — with the
//      "Untouched 30d+" card, its drill and its aggregate all derived from that one expression. A
//      backfill that lets the trigger fire stamps every contact with the migration's timestamp; the
//      card, the drill and the aggregate move together so nothing looks wrong, and the original values
//      are gone.
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

  // The direction of the guess is the decision. Asserted on a row whose created_at is YEARS before the
  // migration, so a backfill that used now() cannot pass by coincidence.
  it("dates an existing task from its creation, never from the migration", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const result = await pg.query<{ same: boolean; assigned_at: string }>(
        `SELECT assigned_at = created_at AS same, assigned_at::text FROM ${schema}.tasks`
      );
      expect(result.rows[0]?.same, `${schema}: assigned_at must equal created_at`).toBe(true);
      expect(result.rows[0]?.assigned_at).toContain("2019-06-07");
    }
  });

  // Seeded on a row the backfill DOES rewrite: asserting on one it skips would pass whatever happened.
  it("leaves updated_at untouched — the contacts 'Last touch' column depends on it", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const result = await pg.query<{ updated_at: string }>(
        `SELECT updated_at::text FROM ${schema}.tasks`
      );
      expect(result.rows[0]?.updated_at, `${schema}: set_tasks_updated_at fired`).toContain("2020-01-02");
    }
  });

  it("writes no audit rows for a column no person edited", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    const result = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.audit_log_probe`);
    expect(result.rows[0]?.n).toBe(0);
  });

  it("re-enables both triggers afterwards", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const result = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_trigger
          WHERE tgrelid = '${schema}.tasks'::regclass AND tgenabled = 'D'`
      );
      expect(result.rows[0]?.n, `${schema}: a trigger was left disabled`).toBe(0);
    }
  });

  it("is idempotent — a second run neither errors nor moves the dates", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    for (const schema of OFFICES) {
      const result = await pg.query<{ same: boolean; updated_at: string }>(
        `SELECT assigned_at = created_at AS same, updated_at::text FROM ${schema}.tasks`
      );
      expect(result.rows[0]?.same, schema).toBe(true);
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
