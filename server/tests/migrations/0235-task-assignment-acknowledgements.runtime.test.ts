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
// the migration, so it comes out correct even if the runner step is broken. A third office has no second
// source: only the per-office step can give it the table, the constraint and the index.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";
import { runTaskAssignmentAcknowledgementsMigration } from "../../src/migrations/task-assignment-acknowledgements.js";

const MIGRATION = "0235_task_assignment_acknowledgements";
const TABLE = "task_assignment_acknowledgements";
const INDEX_NAME = "task_assignment_ack_user_idx";
const UNIQUE_NAME = "task_assignment_ack_uq";

const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/migrations/runner.ts");
const runnerSource = readFileSync(runnerPath, "utf8");

let pg: PGlite;

/** Matches runner.ts's 0235 path: install the durable fence, then scan existing offices. */
async function applyMigration() {
  await pg.exec(migrationSql(MIGRATION));
  await runTaskAssignmentAcknowledgementsMigration(
    pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
  );
}

/** The minimum shape 0235 needs: a tenant `tasks` table with the columns the seed reads. */
async function seedOffices(schemas: readonly string[]) {
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.offices (slug text PRIMARY KEY);`);

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

/** The shape a #1107-era API image can commit: it has tasks, but no 0235 acknowledgement table. */
function legacyProvisionSql(slug: string) {
  const schema = `office_${slug}`;

  return `
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(500) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      assigned_to uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;
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
      ('aaaaaaaa-0000-0000-0000-000000000001', 'pending manual',    'pending',     '${ALICE}', 'manual'),
      ('aaaaaaaa-0000-0000-0000-000000000002', 'pending automated', 'pending',     '${BOB}',   'automated'),
      -- Active work, which is what a REASSIGNMENT hands somebody: the predicate treats it as a
      -- first-time assignment, so the seed has to cover it or every in-flight task in production
      -- becomes brand new on deploy day.
      ('aaaaaaaa-0000-0000-0000-000000000004', 'already started',   'in_progress', '${ALICE}', 'manual'),
      -- Terminal, and the control: it proves the filter is a real filter rather than a blanket copy.
      ('aaaaaaaa-0000-0000-0000-000000000003', 'already done',      'completed',   '${ALICE}', 'manual');
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

afterEach(async () => {
  await pg.close();
});

describe("migration 0235 — task assignment acknowledgements", () => {
  it("creates the table in EVERY office schema, not just the first", async () => {
    await seedOffices(OFFICES);
    await applyMigration();

    for (const schema of OFFICES) {
      expect(await tableExists(schema, TABLE), schema).toBe(true);
    }
  });

  it("builds the (user_id, acknowledged_at) index in EVERY office schema", async () => {
    await seedOffices(OFFICES);
    await applyMigration();

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
    await applyMigration();

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
  it("seeds an ack row for every NON-TERMINAL task that already exists, in EVERY office schema", async () => {
    await seedOffices(OFFICES);
    for (const schema of OFFICES) await seedTasks(schema);
    await applyMigration();

    for (const schema of OFFICES) {
      const acked = await pg.query<{ task_id: string; user_id: string }>(
        `SELECT task_id, user_id FROM ${schema}.${TABLE} ORDER BY task_id`
      );
      expect(acked.rows.map((r) => r.task_id), schema).toEqual([
        "aaaaaaaa-0000-0000-0000-000000000001",
        "aaaaaaaa-0000-0000-0000-000000000002",
        // ...and the in_progress one. Absent here, a reassigned active task looks brand new on deploy.
        "aaaaaaaa-0000-0000-0000-000000000004",
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
    await applyMigration();

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
    await applyMigration();

    // A task created BETWEEN the two runs must not be retro-acked by the replay either... except that
    // the replay cannot tell it apart from history, so it will be. What matters is that the replay is
    // safe: no error, no duplicate rows. (The runner never replays an applied migration; this covers a
    // hand re-run against a restored dump.)
    await expect(applyMigration()).resolves.toBeUndefined();

    for (const schema of OFFICES) {
      const rows = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${schema}.${TABLE}`);
      expect(rows.rows[0]?.n, schema).toBe(3);
    }
  });

  it("installs the deferred old-provisioner fence before the existing-office scan and ledger", () => {
    const source = migrationSql(MIGRATION);
    const guard = source.indexOf(
      "CREATE CONSTRAINT TRIGGER task_assignment_acknowledgements_on_office_provision"
    );
    const tenantBlock = source.indexOf("-- TENANT_SCHEMA_START");
    const branch = runnerSource.indexOf(`file === TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_MIGRATION`);
    const sql = runnerSource.indexOf("await client.query(sql)", branch);
    const scan = runnerSource.indexOf("await runTaskAssignmentAcknowledgementsMigration(client)", sql);
    const ledger = runnerSource.indexOf('"INSERT INTO public._migrations (name) VALUES ($1)"', branch);

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(source.slice(guard, tenantBlock)).toContain("AFTER INSERT ON public.offices");
    expect(source.slice(guard, tenantBlock)).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(guard, "the guard must exist before the provisioner-only template").toBeLessThan(tenantBlock);

    expect(branch).toBeGreaterThanOrEqual(0);
    expect(sql, "the SQL file installs the durable fence").toBeGreaterThan(branch);
    expect(scan, "the existing-office scan must run after the fence").toBeGreaterThan(sql);
    expect(ledger, "never record 0235 until both the fence and scan completed").toBeGreaterThan(scan);
  });

  it("repairs a legacy #1107 provisioner at COMMIT, then converges idempotently with the runner step", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    // INSERT is intentionally first, exactly like createOffice. If the constraint trigger becomes
    // immediate, it fires before tasks exists and this old-image transaction cannot commit.
    await pg.exec(`
      BEGIN;
      INSERT INTO public.offices (slug) VALUES ('tulsa');
      ${legacyProvisionSql("tulsa")}
      COMMIT;
    `);

    expect(await tableExists("office_tulsa", TABLE)).toBe(true);
    const guarded = await pg.query<{ indexes: number; constraints: number; rows: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE schemaname = 'office_tulsa' AND indexname = '${INDEX_NAME}') AS indexes,
        (SELECT COUNT(*)::int FROM pg_constraint
          WHERE conrelid = 'office_tulsa.${TABLE}'::regclass AND conname = '${UNIQUE_NAME}') AS constraints,
        (SELECT COUNT(*)::int FROM office_tulsa.${TABLE}) AS rows
    `);
    expect(guarded.rows[0]).toMatchObject({ indexes: 1, constraints: 1, rows: 0 });

    // The ordinary runner scan immediately follows the SQL file. It must safely meet the table the
    // guard already made, rather than duplicating its index or constraint.
    await expect(
      runTaskAssignmentAcknowledgementsMigration(
        pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
      )
    ).resolves.toBeUndefined();

    const converged = await pg.query<{ indexes: number; constraints: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE schemaname = 'office_tulsa' AND indexname = '${INDEX_NAME}') AS indexes,
        (SELECT COUNT(*)::int FROM pg_constraint
          WHERE conrelid = 'office_tulsa.${TABLE}'::regclass AND conname = '${UNIQUE_NAME}') AS constraints
    `);
    expect(converged.rows[0]).toMatchObject({ indexes: 1, constraints: 1 });

    // A task created after the fenced office commits is new, not historical. Prove the guard really
    // installed the same writable, cascading table shape as the normal provisioner template.
    await pg.exec(`
      INSERT INTO office_tulsa.tasks (id, title, assigned_to)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000099', 'new task', '${ALICE}');
      INSERT INTO office_tulsa.${TABLE} (task_id, user_id)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000099', '${ALICE}')
      ON CONFLICT (task_id, user_id) DO NOTHING;
      INSERT INTO office_tulsa.${TABLE} (task_id, user_id)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000099', '${ALICE}')
      ON CONFLICT (task_id, user_id) DO NOTHING;
    `);
    const oneAck = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM office_tulsa.${TABLE}`
    );
    expect(oneAck.rows[0]?.n).toBe(1);

    await pg.exec(`DELETE FROM office_tulsa.tasks WHERE id = 'aaaaaaaa-0000-0000-0000-000000000099'`);
    const cascaded = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM office_tulsa.${TABLE}`
    );
    expect(cascaded.rows[0]?.n).toBe(0);
  });

  it("fails closed if a caller forces the deferred guard before tasks exists", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    await pg.exec("BEGIN");
    await pg.exec(`INSERT INTO public.offices (slug) VALUES ('too_early')`);
    await expect(pg.exec("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow(
      /before its tasks table was provisioned/
    );
    await pg.exec("ROLLBACK");

    const visible = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM public.offices WHERE slug = 'too_early'`
    );
    expect(visible.rows[0]?.n).toBe(0);
  });

  // The office provisioner replays ONLY the marked block for offices created after this deploy, so
  // drift between the block and the loop leaves new offices silently without the table -- and the
  // modal then never fires for anyone in that office, with no error anywhere.
  it("carries a tenant block that converges idempotently with the permanent provisioning fence", async () => {
    const source = migrationSql(MIGRATION);
    const startIdx = source.indexOf("-- TENANT_SCHEMA_START");
    const endIdx = source.indexOf("-- TENANT_SCHEMA_END");
    expect(startIdx, "tenant block start marker").toBeGreaterThan(-1);
    expect(endIdx, "tenant block end marker").toBeGreaterThan(startIdx);

    // The provisioner takes the FIRST occurrence of the start marker, so a prose mention of it above
    // the real block would hand every new office a fragment of a comment instead of DDL.
    expect(source.indexOf("-- TENANT_SCHEMA_START", startIdx + 1), "duplicate start marker").toBe(-1);

    const block = source.slice(startIdx + "-- TENANT_SCHEMA_START".length, endIdx).trim();

    // Model a production migration first, including a retry: one durable guard only. The provisioner
    // later replays its tenant block in a fresh office transaction, and the same guard sees that already
    // complete shape at COMMIT. Both paths must be harmless together.
    await seedOffices(["office_dallas"]);
    await pg.exec(source);
    await expect(pg.exec(source)).resolves.toBeDefined();

    // Exactly what provisionOfficeSchema does: swap the placeholder schema, run it against a fresh one.
    await seedOffices(["office_tulsa"]);
    await pg.exec(block.replace(/office_dallas/g, "office_tulsa"));
    await pg.exec(`
      BEGIN;
      INSERT INTO public.offices (slug) VALUES ('tulsa');
      COMMIT;
    `);

    expect(await tableExists("office_tulsa", TABLE)).toBe(true);
    const idx = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE schemaname = 'office_tulsa' AND indexname = $1`,
      [INDEX_NAME]
    );
    expect(idx.rows[0]?.n).toBe(1);
    const guard = await pg.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM pg_trigger
       WHERE tgrelid = 'public.offices'::regclass
         AND tgname = 'task_assignment_acknowledgements_on_office_provision'
         AND NOT tgisinternal
    `);
    expect(guard.rows[0]?.n).toBe(1);
  });

  // A partially-provisioned office (schema exists, tasks table does not) must be skipped, not abort the
  // migration -- and with it every other tenant in the same deploy.
  it("skips an office schema that has no tasks table instead of aborting the deploy", async () => {
    await seedOffices(OFFICES);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_halfbuilt;`);

    await expect(applyMigration()).resolves.toBeUndefined();
    expect(await tableExists("office_halfbuilt", TABLE)).toBe(false);
    expect(await tableExists("office_houston", TABLE)).toBe(true);
  });

  it("keeps the lock-taking existing-office work out of the SQL file and commits each office before the next", async () => {
    const source = migrationSql(MIGRATION);
    // Mutating the old DO loop back into the file would return to runner.ts's one implicit migration
    // transaction. The PGlite behaviour tests above cannot observe locks; this source assertion makes
    // the boundary explicit while the recording client below proves the replacement's transaction shape.
    expect(source).not.toMatch(/\bDO\s+\$tenant\$/i);

    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text.trim());
      if (text.includes("information_schema.schemata")) {
        return { rows: [{ schema_name: "office_dallas" }, { schema_name: "office_atlanta" }] };
      }
      if (text.includes("information_schema.tables") || text.includes("information_schema.columns")) {
        return { rows: [{ n: 1 }] };
      }
      return { rows: [] };
    });

    await runTaskAssignmentAcknowledgementsMigration({ query } as never);

    const kind = (statement: string) => {
      if (statement === "BEGIN" || statement === "COMMIT") return statement;
      if (/^CREATE TABLE/i.test(statement)) return "CREATE TABLE";
      if (/^CREATE INDEX/i.test(statement)) return "CREATE INDEX";
      if (/^INSERT INTO/i.test(statement)) return "SEED";
      return null;
    };
    expect(statements.map(kind).filter(Boolean)).toEqual([
      "BEGIN", "CREATE TABLE", "CREATE INDEX", "SEED", "COMMIT",
      "BEGIN", "CREATE TABLE", "CREATE INDEX", "SEED", "COMMIT",
    ]);
  });
});
