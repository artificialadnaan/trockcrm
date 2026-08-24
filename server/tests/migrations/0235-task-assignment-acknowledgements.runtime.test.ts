// Executes migration 0235 FROM DISK against a real Postgres (PGlite).
//
// 0235 adds the per-office `task_assignment_acknowledgements` table that the login modal reads, and
// SEEDS it for every task that already exists. Four properties are worth executing rather than reading:
//
//   1. THE BACKFILL IS THE FEATURE'S SAFETY VALVE. Without it the "no ack row" branch matches the whole
//      history of assignments: at LIMIT 5 a user holding 200 open tasks meets an interrupting modal on
//      ~40 consecutive logins before it goes quiet. A migration that creates the table and skips the
//      seed still deploys cleanly, still passes every service test, and is only discovered by the people
//      it happens to. So the seed is asserted on rows, not inferred from the file.
//   2. IT MUST REACH EVERY OFFICE SCHEMA. A tenant table that misses a schema does not break loudly --
//      the modal query 42P01s inside a try/catch and that office simply never sees the feature.
//   3. THE UNIQUE CONSTRAINT MUST ACTUALLY CONSTRAIN. Every write goes through ON CONFLICT DO NOTHING,
//      which is a syntax error at runtime ("no unique or exclusion constraint matching") if the
//      constraint is missing -- so acknowledgement would 500 on the happy path, not degrade.
//   4. CASCADE ON TASK DELETE. Ack rows outlive nothing; a deleted task that leaves its ack row behind
//      re-uses the row for the next task that lands on that uuid, which is not a thing that can happen,
//      but the FK is also what stops an ack row for a task in another office.
//
// THREE offices, deliberately. office_dallas is ALSO written by the literal tenant block at the foot of
// the migration, so it comes out correct even if the tenant loop is broken -- and a two-office fixture
// (dallas + one) still passes with the loop clamped to a single schema, because between them the loop's
// one schema and the block's one schema cover both. A third office has no second source: only the loop
// can give it the table, the constraint and the index.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0235_task_assignment_acknowledgements";
const TABLE = "task_assignment_acknowledgements";
const INDEX_NAME = "task_assignment_ack_user_idx";
const UNIQUE_NAME = "task_assignment_ack_uq";

const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

let pg: PGlite;

/** The minimum shape 0235 needs: a tenant `tasks` table with the columns the seed reads. */
async function seedOffices(schemas: readonly string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(500) NOT NULL,
        priority varchar(20) NOT NULL DEFAULT 'normal',
        status varchar(20) NOT NULL DEFAULT 'pending',
        assigned_to uuid NOT NULL,
        created_by uuid,
        due_date date,
        source varchar(20) NOT NULL DEFAULT 'automated',
        is_test_data boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}

/**
 * Two rows the seed MUST cover and one it must not.
 *
 * The completed row is the control: it proves the seed is filtered rather than a blanket copy of the
 * table. A blanket copy would also pass every "pre-existing task does not pop" assertion, so without a
 * row the seed is supposed to skip, the filter is untested.
 */
async function seedTasks(schema: string) {
  await pg.exec(`
    INSERT INTO ${schema}.tasks (id, title, status, assigned_to, source) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', 'pending manual',    'pending',   '${ALICE}', 'manual'),
      ('aaaaaaaa-0000-0000-0000-000000000002', 'pending automated', 'pending',   '${BOB}',   'automated'),
      ('aaaaaaaa-0000-0000-0000-000000000003', 'already done',      'completed', '${ALICE}', 'manual');
  `);
}

async function tableExists(schema: string, table: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0235 — task assignment acknowledgements", () => {
  it("creates the table in EVERY office schema, not just the first", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      expect(await tableExists(schema, TABLE), schema).toBe(true);
    }
  });

  it("builds the (user_id, acknowledged_at) index in EVERY office schema", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const result = await pg.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
        [schema, INDEX_NAME]
      );
      expect(result.rows[0]?.indexdef, `${schema}.${INDEX_NAME}`).toBeDefined();
      expect(result.rows[0]!.indexdef).toContain("user_id");
    }
  });

  // EXECUTED, not read out of pg_constraint: a constraint that exists but does not constrain is the
  // failure this catches, and every acknowledgement write depends on it being an ON CONFLICT target.
  it("enforces one ack row per (task, user) in EVERY office schema, via ON CONFLICT", async () => {
    await seedOffices(OFFICES);
    for (const schema of OFFICES) await seedTasks(schema);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      // The seed already acked task ...001 for ALICE. A second write must collapse, not raise, and
      // must go through ON CONFLICT -- which is only valid SQL if the unique constraint is present.
      await expect(
        pg.exec(`
          INSERT INTO ${schema}.${TABLE} (task_id, user_id)
          VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '${ALICE}')
          ON CONFLICT (task_id, user_id) DO NOTHING;
        `),
        schema
      ).resolves.toBeDefined();

      const rows = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${schema}.${TABLE}
          WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND user_id = $1`,
        [ALICE]
      );
      expect(rows.rows[0]?.n, schema).toBe(1);

      // ...and a bare duplicate INSERT is still rejected, so the constraint is real.
      await expect(
        pg.exec(`
          INSERT INTO ${schema}.${TABLE} (task_id, user_id)
          VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '${ALICE}');
        `),
        schema
      ).rejects.toThrow();
    }

    const named = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = $1`,
      [UNIQUE_NAME]
    );
    expect(named.rows[0]?.n).toBe(OFFICES.length);
  });

  // C3. Without this the modal is a ~40-login nag for anyone with a real backlog.
  it("seeds an ack row for every PENDING task that already exists, in EVERY office schema", async () => {
    await seedOffices(OFFICES);
    for (const schema of OFFICES) await seedTasks(schema);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const acked = await pg.query<{ task_id: string; user_id: string }>(
        `SELECT task_id, user_id FROM ${schema}.${TABLE} ORDER BY task_id`
      );
      expect(acked.rows.map((r) => r.task_id), schema).toEqual([
        "aaaaaaaa-0000-0000-0000-000000000001",
        "aaaaaaaa-0000-0000-0000-000000000002",
      ]);
      // The ack is recorded against the ASSIGNEE, not the creator -- a later reassignment leaves the
      // new assignee with no row, which is exactly when the modal should fire again.
      expect(acked.rows[0]?.user_id, schema).toBe(ALICE);
      expect(acked.rows[1]?.user_id, schema).toBe(BOB);
    }
  });

  it("cascades ack rows away when the task is deleted, in EVERY office schema", async () => {
    await seedOffices(OFFICES);
    for (const schema of OFFICES) await seedTasks(schema);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await pg.exec(`DELETE FROM ${schema}.tasks WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'`);
      const left = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${schema}.${TABLE}
          WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000001'`
      );
      expect(left.rows[0]?.n, schema).toBe(0);
    }
  });

  it("is idempotent — a second run neither errors nor duplicates the seed", async () => {
    await seedOffices(OFFICES);
    for (const schema of OFFICES) await seedTasks(schema);
    await pg.exec(migrationSql(MIGRATION));

    // A task created BETWEEN the two runs must not be retro-acked by the replay either... except that
    // the replay cannot tell it apart from history, so it will be. What matters is that the replay is
    // safe: no error, no duplicate rows. (The runner never replays an applied migration; this covers a
    // hand re-run against a restored dump.)
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    for (const schema of OFFICES) {
      const rows = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${schema}.${TABLE}`);
      expect(rows.rows[0]?.n, schema).toBe(2);
    }
  });

  // The office provisioner replays ONLY the marked block for offices created after this deploy, so
  // drift between the block and the loop leaves new offices silently without the table -- and the
  // modal then never fires for anyone in that office, with no error anywhere.
  it("carries a tenant block that provisions a brand-new office schema", async () => {
    const source = migrationSql(MIGRATION);
    const startIdx = source.indexOf("-- TENANT_SCHEMA_START");
    const endIdx = source.indexOf("-- TENANT_SCHEMA_END");
    expect(startIdx, "tenant block start marker").toBeGreaterThan(-1);
    expect(endIdx, "tenant block end marker").toBeGreaterThan(startIdx);

    // The provisioner takes the FIRST occurrence of the start marker, so a prose mention of it above
    // the real block would hand every new office a fragment of a comment instead of DDL.
    expect(source.indexOf("-- TENANT_SCHEMA_START", startIdx + 1), "duplicate start marker").toBe(-1);

    const block = source.slice(startIdx + "-- TENANT_SCHEMA_START".length, endIdx).trim();

    // Exactly what provisionOfficeSchema does: swap the placeholder schema, run it against a fresh one.
    await seedOffices(["office_tulsa"]);
    await pg.exec(block.replace(/office_dallas/g, "office_tulsa"));

    expect(await tableExists("office_tulsa", TABLE)).toBe(true);
    const idx = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE schemaname = 'office_tulsa' AND indexname = $1`,
      [INDEX_NAME]
    );
    expect(idx.rows[0]?.n).toBe(1);
  });

  // A partially-provisioned office (schema exists, tasks table does not) must be skipped, not abort the
  // migration -- and with it every other tenant in the same deploy.
  it("skips an office schema that has no tasks table instead of aborting the deploy", async () => {
    await seedOffices(OFFICES);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_halfbuilt;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await tableExists("office_halfbuilt", TABLE)).toBe(false);
    expect(await tableExists("office_houston", TABLE)).toBe(true);
  });
});
