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
import {
  TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE,
  TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE,
  TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_GLOBAL_CUTOVER_TABLE,
  TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL,
  captureTaskAssignmentAcknowledgementBaselines,
  materializeTaskAssignmentAcknowledgementBaselines,
  runTaskAssignmentAcknowledgementsMigration,
} from "../../src/migrations/task-assignment-acknowledgements.js";
import {
  extractTasksAssignedAtVersioningGlobals,
  runTasksAssignedAtVersioning,
  runTasksAssignedAtBackfill,
} from "../../src/migrations/tasks-assigned-at-backfill.js";

const MIGRATION = "0235_task_assignment_acknowledgements";
const ASSIGNED_AT_MIGRATION = "0239_tasks_assigned_at";
const TABLE = "task_assignment_acknowledgements";
const INDEX_NAME = "task_assignment_ack_user_idx";
const UNIQUE_NAME = "task_assignment_ack_uq";

const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/migrations/runner.ts");
const runnerSource = readFileSync(runnerPath, "utf8");

let pg: PGlite;

/**
 * Matches runner.ts's 0235 preflight: make assignment versions writable before taking the global
 * acknowledgement snapshot. The later 0239 NULL backfill deliberately remains outside this helper.
 */
async function installAssignedAtVersioningPreflight() {
  await pg.exec(extractTasksAssignedAtVersioningGlobals(migrationSql(ASSIGNED_AT_MIGRATION)));
  await runTasksAssignedAtVersioning(
    pg as unknown as Parameters<typeof runTasksAssignedAtVersioning>[0]
  );
}

/** Install the 0239 preflight and then the 0235 office-provisioning fence, exactly in runner order. */
async function installAcknowledgementMigrationSql() {
  await installAssignedAtVersioningPreflight();
  await pg.exec(migrationSql(MIGRATION));
}

/** Matches runner.ts's 0235 path: preflight versioning, install the durable fence, then cut over. */
async function applyMigration() {
  await installAcknowledgementMigrationSql();
  await runTaskAssignmentAcknowledgementsMigration(
    pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
  );
}

/** The minimum shape 0235 needs: a tenant `tasks` table with the columns the seed reads. */
async function seedOffices(schemas: readonly string[]) {
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.offices (slug text PRIMARY KEY);`);
  await pg.exec(`
    CREATE OR REPLACE FUNCTION public.test_set_tasks_updated_at()
    RETURNS trigger AS $fn$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION public.test_audit_tasks()
    RETURNS trigger AS $fn$
    BEGIN
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);

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
      CREATE TRIGGER set_tasks_updated_at
        BEFORE UPDATE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION public.test_set_tasks_updated_at();
      CREATE TRIGGER audit_tasks
        BEFORE UPDATE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION public.test_audit_tasks();
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
    CREATE TRIGGER set_tasks_updated_at
      BEFORE UPDATE ON ${schema}.tasks
      FOR EACH ROW EXECUTE FUNCTION public.test_set_tasks_updated_at();
    CREATE TRIGGER audit_tasks
      BEFORE UPDATE ON ${schema}.tasks
      FOR EACH ROW EXECUTE FUNCTION public.test_audit_tasks();
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

async function cutoverState(schema: string) {
  const result = await pg.query<{ state: string }>(
    `SELECT state FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE} WHERE schema_name = $1`,
    [schema]
  );
  return result.rows[0]?.state;
}

async function baselinePairCount(schema: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE}
      WHERE schema_name = $1`,
    [schema]
  );
  return result.rows[0]?.n ?? 0;
}

async function globalCutoverExists() {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_GLOBAL_CUTOVER_TABLE}`
  );
  return (result.rows[0]?.n ?? 0) === 1;
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

  it("keeps a historical future assignment version acknowledged after the full cutover", async () => {
    await seedOffices(["office_dallas"]);
    await seedTasks("office_dallas");
    // This is a restored/future version which pre-dates the cutover. 0239 deliberately preserves it:
    // only NULL history is backfilled, so the baseline acknowledgement must be no earlier than it.
    await installAcknowledgementMigrationSql();
    await pg.query(
      `UPDATE office_dallas.tasks
          SET assigned_at = $1::timestamptz
        WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'`,
      ["2099-01-02T03:04:05.123456Z"]
    );

    await runTaskAssignmentAcknowledgementsMigration(
      pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
    );
    await runTasksAssignedAtBackfill(
      pg as unknown as Parameters<typeof runTasksAssignedAtBackfill>[0]
    );

    const result = await pg.query<{ pending: boolean; coversAssignment: boolean }>(`
      SELECT NOT EXISTS (
               SELECT 1
                 FROM office_dallas.task_assignment_acknowledgements AS acknowledgements
                WHERE acknowledgements.task_id = tasks.id
                  AND acknowledgements.user_id = tasks.assigned_to
                  AND acknowledgements.acknowledged_at >= tasks.assigned_at
             ) AS pending,
             acknowledgements.acknowledged_at >= tasks.assigned_at AS "coversAssignment"
        FROM office_dallas.tasks AS tasks
        JOIN office_dallas.task_assignment_acknowledgements AS acknowledgements
          ON acknowledgements.task_id = tasks.id
         AND acknowledgements.user_id = tasks.assigned_to
       WHERE tasks.id = 'aaaaaaaa-0000-0000-0000-000000000001'
    `);
    // This is the live pending predicate's acknowledgement condition. If the capture used its earlier
    // wall clock directly, it would be false and the historical task would interrupt its assignee.
    expect(result.rows[0]).toMatchObject({ pending: false, coversAssignment: true });
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

  it("marks completed offices seeded, so a retry never acknowledges tasks created after their cutover", async () => {
    await seedOffices(OFFICES);
    for (const schema of OFFICES) await seedTasks(schema);
    await applyMigration();

    // Model a retry after another office failed later in the migration. These are normal assignments
    // created after each completed office's durable baseline; replaying the helper must not sample them.
    for (const schema of OFFICES) {
      await pg.exec(`
        INSERT INTO ${schema}.tasks (id, title, status, assigned_to, source)
        VALUES ('aaaaaaaa-0000-0000-0000-000000000099', 'after cutover', 'pending', '${ALICE}', 'manual');
      `);
    }

    await expect(applyMigration()).resolves.toBeUndefined();

    for (const schema of OFFICES) {
      const rows = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${schema}.${TABLE}`);
      expect(rows.rows[0]?.n, schema).toBe(3);
      const late = await pg.query<{ n: number }>(`
        SELECT COUNT(*)::int AS n FROM ${schema}.${TABLE}
        WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000099' AND user_id = '${ALICE}'
      `);
      expect(late.rows[0]?.n, `${schema} post-cutover task`).toBe(0);
      expect(await cutoverState(schema), schema).toBe("seeded");
      expect(await baselinePairCount(schema), schema).toBe(0);
    }
  });

  it("materializes only unchanged pre-DDL assignment versions when tasks arrive or move between phases", async () => {
    await seedOffices(["office_dallas"]);
    await seedTasks("office_dallas");
    await installAcknowledgementMigrationSql();

    await captureTaskAssignmentAcknowledgementBaselines(
      pg as unknown as Parameters<typeof captureTaskAssignmentAcknowledgementBaselines>[0]
    );
    expect(await globalCutoverExists()).toBe(true);
    expect(await cutoverState("office_dallas")).toBe("captured");
    expect(await baselinePairCount("office_dallas")).toBe(3);

    // This assignment is after phase 1 but before phase 2's table DDL. The old current-table seed
    // would silently acknowledge it; the durable pair table must not contain it. Likewise, a captured
    // task that moves after the snapshot must not receive an acknowledgement for its stale assignment.
    await pg.exec(`
      -- Pin a deliberately old baseline time. The materializer must copy this exact stored value,
      -- rather than evaluating now() while it later obtains the DDL lock.
      UPDATE ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE}
      SET baseline_ack_at = '2001-01-01T00:00:00Z'
      WHERE schema_name = 'office_dallas';
      -- This old-image reassignment advances assigned_at through 0239's preflight trigger. The durable
      -- pair is for ALICE's NULL pre-backfill version, so phase 2 must not seed it for either version.
      UPDATE office_dallas.tasks
      SET assigned_to = '${BOB}'
      WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
      INSERT INTO office_dallas.tasks (id, title, status, assigned_to, source)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000099', 'between phases', 'pending', '${ALICE}', 'manual');
    `);

    await materializeTaskAssignmentAcknowledgementBaselines(
      pg as unknown as Parameters<typeof materializeTaskAssignmentAcknowledgementBaselines>[0]
    );

    const seeded = await pg.query<{ task_id: string }>(
      `SELECT task_id FROM office_dallas.${TABLE} ORDER BY task_id`
    );
    expect(seeded.rows.map((row) => row.task_id)).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000002",
      "aaaaaaaa-0000-0000-0000-000000000004",
    ]);
    const preserved = await pg.query<{ user_id: string; acknowledged_at: Date }>(`
      SELECT user_id, acknowledged_at
      FROM office_dallas.${TABLE}
      WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000002'
    `);
    expect(preserved.rows[0]?.user_id, "an unchanged nullable assignment version remains baseline-acknowledged").toBe(BOB);
    expect(new Date(preserved.rows[0]!.acknowledged_at).toISOString()).toBe("2001-01-01T00:00:00.000Z");
    const moved = await pg.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n
      FROM office_dallas.${TABLE}
      WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    `);
    expect(moved.rows[0]?.n, "a post-snapshot assignment is not baseline-acknowledged").toBe(0);
    expect(await cutoverState("office_dallas")).toBe("seeded");
    expect(await baselinePairCount("office_dallas")).toBe(0);
  });

  it("stamps an old-image A→B→A hand-back before 0239's normal backfill and does not baseline-acknowledge it", async () => {
    await seedOffices(["office_dallas"]);
    await seedTasks("office_dallas");
    await installAcknowledgementMigrationSql();
    await captureTaskAssignmentAcknowledgementBaselines(
      pg as unknown as Parameters<typeof captureTaskAssignmentAcknowledgementBaselines>[0]
    );

    const captured = await pg.query<{ baseline_assigned_at: Date | null }>(`
      SELECT baseline_assigned_at
      FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE}
      WHERE schema_name = 'office_dallas'
        AND task_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    `);
    // The 0239 preflight intentionally precedes its NULL-only history backfill. NULL is a meaningful
    // captured version, not an absent value to wildcard during phase 2.
    expect(captured.rows[0]?.baseline_assigned_at).toBeNull();

    // Model an older API image which knows only assigned_to. Returning the task to Alice leaves the
    // current assignee equal to its snapshot assignee, so assignee-only materialization would seed the
    // new hand-back. 0239's compatibility trigger makes the new version observable before its backfill.
    await pg.exec(`
      UPDATE office_dallas.tasks
      SET assigned_to = '${BOB}'
      WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
    `);
    await pg.exec(`
      UPDATE office_dallas.tasks
      SET assigned_to = '${ALICE}'
      WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
    `);
    const beforeNormalBackfill = await pg.query<{ stamped: boolean }>(`
      SELECT assigned_at > created_at AS stamped
      FROM office_dallas.tasks
      WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'
    `);
    expect(beforeNormalBackfill.rows[0]?.stamped, "0239 preflight trigger must stamp the old-image hand-back").toBe(
      true
    );

    await materializeTaskAssignmentAcknowledgementBaselines(
      pg as unknown as Parameters<typeof materializeTaskAssignmentAcknowledgementBaselines>[0]
    );
    // The normal 0239 migration still runs later. Its NULL-only backfill must preserve the real
    // old-image handoff timestamp instead of replacing it with created_at.
    await runTasksAssignedAtBackfill(pg as unknown as Parameters<typeof runTasksAssignedAtBackfill>[0]);

    const handBack = await pg.query<{ stamped: boolean; assigned_to: string }>(`
      SELECT assigned_at > created_at AS stamped, assigned_to::text AS assigned_to
      FROM office_dallas.tasks
      WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'
    `);
    expect(handBack.rows[0]).toMatchObject({ stamped: true, assigned_to: ALICE });
    const acknowledgements = await pg.query<{ user_id: string }>(`
      SELECT user_id::text AS user_id
      FROM office_dallas.${TABLE}
      WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      ORDER BY user_id
    `);
    expect(acknowledgements.rows, "the returned assignment is newer than the captured ALICE version").toEqual([]);
  });

  it("serializes 0239 versioning, 0235's fence, two phases and ledger behind one session lock", () => {
    const source = migrationSql(MIGRATION);
    const guard = source.indexOf(
      "CREATE CONSTRAINT TRIGGER task_assignment_acknowledgements_on_office_provision"
    );
    const legacyBridge = source.indexOf(
      "INSERT INTO public._task_assignment_acknowledgements_cutovers (schema_name, state)\n" +
        "SELECT schema_name, 'post_fence'\n" +
        "FROM public._task_assignment_acknowledgements_fenced_offices"
    );
    const tenantBlock = source.indexOf("-- TENANT_SCHEMA_START");
    const lock = runnerSource.indexOf("SELECT pg_advisory_lock(hashtext($1))");
    const recheck = runnerSource.indexOf("SELECT id FROM public._migrations WHERE name = $1", lock);
    const versioningPreflight = runnerSource.indexOf(
      "await installTasksAssignedAtVersioningBeforeAcknowledgementCutover(client)",
      recheck
    );
    const sql = runnerSource.indexOf("await client.query(sql)", recheck);
    const phases = runnerSource.indexOf("await runTaskAssignmentAcknowledgementsMigration(client)", sql);
    const ledger = runnerSource.indexOf('"INSERT INTO public._migrations (name) VALUES ($1)"', phases);
    const unlock = runnerSource.indexOf("SELECT pg_advisory_unlock(hashtext($1))", ledger);

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(source.slice(guard, tenantBlock)).toContain("AFTER INSERT ON public.offices");
    expect(source.slice(guard, tenantBlock)).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(guard, "the guard must exist before the provisioner-only template").toBeLessThan(tenantBlock);
    // CREATE/DROP TRIGGER serializes an older in-flight provisioner. Its old deferred trigger can write
    // only the legacy marker while that DDL waits, so copying markers before this point permanently loses
    // the post-fence classification and lets the helper seed the office's first assignment on retry.
    expect(legacyBridge, "the legacy marker bridge must exist").toBeGreaterThanOrEqual(0);
    expect(legacyBridge, "bridge only after trigger replacement has drained old provisioners").toBeGreaterThan(guard);
    expect(legacyBridge, "bridge remains inside the migration SQL sent before the helper").toBeLessThan(tenantBlock);

    // A transaction-scoped advisory lock would release on every per-office COMMIT; only the session
    // variant makes a concurrent runner wait through SQL + capture + materialization + ledger.
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(recheck, "recheck the ledger after acquiring the lock").toBeGreaterThan(lock);
    // 0239's nullable column and old-image assignment trigger must exist BEFORE the 0235 snapshot.
    // Its expensive NULL backfill still belongs in the ordinary later 0239 migration path, not here.
    expect(versioningPreflight, "stage 0239 assignment versioning before 0235").toBeGreaterThan(recheck);
    expect(versioningPreflight, "finish 0239 preflight before installing 0235").toBeLessThan(sql);
    expect(sql, "the SQL file installs the deferred fence under the lock").toBeGreaterThan(recheck);
    expect(phases, "both historical phases run after the fence").toBeGreaterThan(sql);
    expect(ledger, "ledger is written only after both phases").toBeGreaterThan(phases);
    expect(unlock, "release only after the ledger decision").toBeGreaterThan(ledger);
    expect(runnerSource.slice(lock, unlock)).not.toContain("pg_advisory_xact_lock");
  });

  it("bridges a legacy fence-only marker into the canonical post-fence header before discovery", async () => {
    await seedOffices(["office_dallas", "office_tulsa"]);
    // This is the durable artifact left by the immediately preceding unledgered revision. Its old
    // provisioner trigger already created Tulsa's acknowledgement table in production; this focused
    // assertion exercises the bridge/classification boundary rather than recreating that old trigger.
    await pg.exec(`
      CREATE TABLE public._task_assignment_acknowledgements_fenced_offices (
        schema_name text PRIMARY KEY
      );
      INSERT INTO public._task_assignment_acknowledgements_fenced_offices (schema_name)
      VALUES ('office_tulsa');
    `);

    await installAcknowledgementMigrationSql();

    expect(await cutoverState("office_tulsa")).toBe("post_fence");
    const discovered = await pg.query<{ schema_name: string }>(
      TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL
    );
    expect(discovered.rows.map((row) => row.schema_name)).not.toContain("office_tulsa");
  });

  it("repairs a legacy #1107 provisioner at COMMIT without seeding its post-fence tasks on retry", async () => {
    await seedOffices(["office_dallas"]);
    await seedTasks("office_dallas");
    await installAcknowledgementMigrationSql();

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

    const fenced = await pg.query<{ schema_name: string; state: string }>(`
      SELECT schema_name, state
        FROM ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE}
       WHERE state = 'post_fence'
       ORDER BY schema_name
    `);
    expect(fenced.rows).toEqual([{ schema_name: "office_tulsa", state: "post_fence" }]);

    // This task lands after the fenced office commits but before a failed deployment's helper retries.
    // It is a normal, brand-new assignment: if the retry walks every visible office schema and seeds it,
    // the modal can never show it. The durable fence marker must keep this office out of that pass.
    await pg.exec(`
      INSERT INTO office_tulsa.tasks (id, title, assigned_to)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000099', 'new task', '${ALICE}');
    `);

    // Replaying the file models a retry after its first execution installed the fence but the helper
    // failed before runner.ts could record 0235 in public._migrations.
    await pg.exec(migrationSql(MIGRATION));
    await expect(
      runTaskAssignmentAcknowledgementsMigration(
        pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
      )
    ).resolves.toBeUndefined();

    const retrySeed = await pg.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n
        FROM office_tulsa.${TABLE}
       WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000099'
         AND user_id = '${ALICE}'
    `);
    expect(retrySeed.rows[0]?.n, "a post-fence assignment must remain unacknowledged").toBe(0);

    const historicalSeed = await pg.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n
        FROM office_dallas.${TABLE}
       WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000001'
         AND user_id = '${ALICE}'
    `);
    expect(historicalSeed.rows[0]?.n, "the post-fence marker must not skip real history").toBe(1);

    const converged = await pg.query<{ indexes: number; constraints: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE schemaname = 'office_tulsa' AND indexname = '${INDEX_NAME}') AS indexes,
        (SELECT COUNT(*)::int FROM pg_constraint
          WHERE conrelid = 'office_tulsa.${TABLE}'::regclass AND conname = '${UNIQUE_NAME}') AS constraints
    `);
    expect(converged.rows[0]).toMatchObject({ indexes: 1, constraints: 1 });

    // Prove the guard really installed the same writable, cascading table shape as the normal
    // provisioner template. The prior zero-row assertion establishes that this is the first ack.
    await pg.exec(`
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

  it("keeps captured pairs and state when phase 2 rolls back, then resumes from those exact pairs", async () => {
    // office_dallas is the literal new-office template at the foot of 0235's SQL file; use Atlanta so
    // this failure probe exercises only the helper's existing-office path.
    await seedOffices(["office_dallas", "office_atlanta"]);
    await seedTasks("office_atlanta");
    await installAcknowledgementMigrationSql();
    await captureTaskAssignmentAcknowledgementBaselines(
      pg as unknown as Parameters<typeof captureTaskAssignmentAcknowledgementBaselines>[0]
    );
    expect(await globalCutoverExists()).toBe(true);

    // Make the materialization INSERT fail after it has locked the captured header. The acknowledgement
    // table is pre-created only to attach this failure probe; phase 2's real CREATE IF NOT EXISTS and
    // index still execute before the seed.
    await pg.exec(`
      CREATE TABLE office_atlanta.${TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id uuid NOT NULL REFERENCES office_atlanta.tasks(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        acknowledged_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ${UNIQUE_NAME} UNIQUE (task_id, user_id)
      );
      CREATE OR REPLACE FUNCTION public.fail_task_assignment_ack_phase_two()
      RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'phase two seed failure';
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_task_assignment_ack_phase_two
        BEFORE INSERT ON office_atlanta.${TABLE}
        FOR EACH ROW EXECUTE FUNCTION public.fail_task_assignment_ack_phase_two();
    `);

    await expect(
      materializeTaskAssignmentAcknowledgementBaselines(
        pg as unknown as Parameters<typeof materializeTaskAssignmentAcknowledgementBaselines>[0]
      )
    ).rejects.toThrow(/phase two seed failure/);

    // DELETE pairs + state=seeded sit after the seed in the SAME transaction. A rollback must leave
    // both durable capture artifacts intact, not convert a retry into a current-table sample.
    expect(await cutoverState("office_atlanta")).toBe("captured");
    expect(await baselinePairCount("office_atlanta")).toBe(3);
    const failedSeedRows = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM office_atlanta.${TABLE}`
    );
    expect(failedSeedRows.rows[0]?.n).toBe(0);

    // This arrives after the one global snapshot but before this office can be materialized. Retrying
    // the whole cutover must observe the marker and resume the stored pairs, not take a second moving
    // baseline that silently acknowledges the new assignment.
    await pg.exec(`
      INSERT INTO office_atlanta.tasks (id, title, status, assigned_to, source)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000099', 'after global snapshot', 'pending', '${ALICE}', 'manual');
    `);

    await pg.exec(`
      DROP TRIGGER fail_task_assignment_ack_phase_two ON office_atlanta.${TABLE};
      DROP FUNCTION public.fail_task_assignment_ack_phase_two();
    `);
    await runTaskAssignmentAcknowledgementsMigration(
      pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
    );

    expect(await cutoverState("office_atlanta")).toBe("seeded");
    expect(await baselinePairCount("office_atlanta")).toBe(0);
    const resumedRows = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM office_atlanta.${TABLE}`
    );
    expect(resumedRows.rows[0]?.n).toBe(3);
    const lateAck = await pg.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM office_atlanta.${TABLE}
      WHERE task_id = 'aaaaaaaa-0000-0000-0000-000000000099' AND user_id = '${ALICE}'
    `);
    expect(lateAck.rows[0]?.n, "retry must preserve the original global baseline").toBe(0);
  });

  it("rolls back the ENTIRE global phase-1 baseline when a later office capture fails", async () => {
    // Alphabetical discovery reaches Atlanta and Dallas before Houston. Failing only Houston proves
    // the earlier offices did not quietly commit their header/pairs in separate transactions.
    const historicalOffices = ["office_atlanta", "office_dallas", "office_houston"] as const;
    await seedOffices(historicalOffices);
    for (const schema of historicalOffices) await seedTasks(schema);
    await installAcknowledgementMigrationSql();

    // The trigger fires from Phase 1's actual CTE INSERT, but only after two earlier offices have
    // captured rows. If capture regresses to one transaction per office, Atlanta/Dallas remain
    // `captured` here and a retry invents a hybrid baseline around those stale rows.
    await pg.exec(`
      CREATE OR REPLACE FUNCTION public.fail_task_assignment_ack_capture()
      RETURNS trigger AS $fn$
      BEGIN
        IF NEW.schema_name = 'office_houston' THEN
          RAISE EXCEPTION 'phase one capture failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_task_assignment_ack_capture
        BEFORE INSERT ON ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE}
        FOR EACH ROW EXECUTE FUNCTION public.fail_task_assignment_ack_capture();
    `);

    await expect(
      captureTaskAssignmentAcknowledgementBaselines(
        pg as unknown as Parameters<typeof captureTaskAssignmentAcknowledgementBaselines>[0]
      )
    ).rejects.toThrow(/phase one capture failure/);

    for (const schema of historicalOffices) {
      expect(await cutoverState(schema), `${schema} state`).toBeUndefined();
      expect(await baselinePairCount(schema), `${schema} pairs`).toBe(0);
    }
    expect(await globalCutoverExists(), "global marker must commit with ALL pairs, not before them").toBe(false);
    expect(await tableExists("office_atlanta", TABLE)).toBe(false);

    await pg.exec(`
      DROP TRIGGER fail_task_assignment_ack_capture ON ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_BASELINE_PAIRS_TABLE};
      DROP FUNCTION public.fail_task_assignment_ack_capture();
    `);
    await runTaskAssignmentAcknowledgementsMigration(
      pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
    );
    for (const schema of historicalOffices) {
      expect(await cutoverState(schema), `${schema} retry state`).toBe("seeded");
      expect(await baselinePairCount(schema), `${schema} retry pairs`).toBe(0);
    }
    expect(await globalCutoverExists(), "successful retry gets one durable global marker").toBe(true);
  });

  it("fails closed on a legacy captured header without the global snapshot marker", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await installAcknowledgementMigrationSql();
    await pg.exec(`
      INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE} (schema_name, state)
      VALUES ('office_atlanta', 'captured');
    `);

    await expect(
      captureTaskAssignmentAcknowledgementBaselines(
        pg as unknown as Parameters<typeof captureTaskAssignmentAcknowledgementBaselines>[0]
      )
    ).rejects.toThrow(/legacy captured cutover for office_atlanta without a global baseline marker/);

    // The legacy row predates this attempt, so its presence proves the rollback did not paper over an
    // unsafe mixed snapshot. No new global marker or materialization may be invented around it.
    expect(await cutoverState("office_atlanta")).toBe("captured");
    expect(await globalCutoverExists()).toBe(false);
    expect(await tableExists("office_atlanta", TABLE)).toBe(false);
  });

  it("records and completes a cutover for terminal-only and empty historical offices", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(`
      INSERT INTO office_dallas.tasks (id, title, status, assigned_to, source)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000003', 'already done', 'completed', '${ALICE}', 'manual');
    `);

    await applyMigration();

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await tableExists(schema, TABLE), schema).toBe(true);
      expect(await cutoverState(schema), schema).toBe("seeded");
      expect(await baselinePairCount(schema), schema).toBe(0);
      const acks = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${schema}.${TABLE}`);
      expect(acks.rows[0]?.n, schema).toBe(0);
    }
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
    await installAssignedAtVersioningPreflight();
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

  it("skips a legacy tasks shape missing baseline capabilities without blocking healthy offices", async () => {
    await seedOffices(OFFICES);
    // This old shape can exist after the versioning preflight has already safely installed its trigger.
    // The global 0235 snapshot must retain the established compatibility skip rather than taking down
    // every healthy office, and it must not rerun 0239 against a schema that no longer has assigned_to.
    await installAssignedAtVersioningPreflight();
    await pg.exec(`DROP TRIGGER stamp_tasks_assigned_at ON office_houston.tasks;`);
    await pg.exec(`DROP TRIGGER stabilize_tasks_assignment_actor ON office_houston.tasks;`);
    await pg.exec(`ALTER TABLE office_houston.tasks DROP COLUMN assigned_to;`);

    await pg.exec(migrationSql(MIGRATION));
    await expect(
      runTaskAssignmentAcknowledgementsMigration(
        pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
      )
    ).resolves.toBeUndefined();
    expect(await tableExists("office_houston", TABLE)).toBe(false);
    expect(await tableExists("office_atlanta", TABLE)).toBe(true);
    expect(await cutoverState("office_houston")).toBeUndefined();
  });

  it("records one global repeatable-read capture before per-office materialization", async () => {
    const source = migrationSql(MIGRATION);
    // Mutating the old tenant-wide DO loop back into the file would return to one implicit transaction.
    // PGlite cannot observe live contention, so this source assertion plus the recording transcript
    // below pins the actual transaction boundary and the state-machine order.
    expect(source).not.toMatch(/\bDO\s+\$tenant\$/i);

    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      const statement = text.trim();
      statements.push(statement);
      if (text.includes("clock_timestamp() AS baseline_ack_at")) {
        return { rows: [{ baseline_ack_at: new Date("2026-08-26T17:20:08.000Z") }] };
      }
      if (text.includes("information_schema.schemata")) {
        return { rows: [{ schema_name: "office_dallas" }, { schema_name: "office_atlanta" }] };
      }
      if (text.includes("FOR UPDATE") && text.includes(TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE)) {
        return { rows: [{ state: "captured" }] };
      }
      if (text.includes("information_schema.tables") || text.includes("information_schema.columns")) {
        return { rows: [{ n: 1 }] };
      }
      return { rows: [] };
    });

    await runTaskAssignmentAcknowledgementsMigration({ query } as never);

    // Capture discovers under the deployment-wide repeatable-read transaction. Phase 2 discovers later
    // only to resume captured rows; both use the atomic post-fence join, never a stale marker lookup.
    const discoveries = statements.filter((statement) => statement.includes("information_schema.schemata"));
    expect(discoveries).toEqual([
      TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL.trim(),
      TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_HISTORICAL_SCHEMA_DISCOVERY_SQL.trim(),
    ]);
    for (const discovery of discoveries) {
      expect(discovery).toContain("LEFT JOIN");
      expect(discovery).toContain(TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE);
      expect(discovery).toContain("cutovers.state = 'captured'");
      expect(discovery).not.toContain("_fenced_offices");
    }

    const kind = (statement: string) => {
      if (statement === "BEGIN ISOLATION LEVEL REPEATABLE READ") return "BEGIN GLOBAL SNAPSHOT";
      if (statement === "BEGIN" || statement === "COMMIT") return statement;
      if (/^WITH newly_captured/i.test(statement)) return "CAPTURE PAIRS";
      if (statement.startsWith(`INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_GLOBAL_CUTOVER_TABLE}`)) {
        return "MARK GLOBAL CUTOVER";
      }
      if (statement.includes("FOR UPDATE") && statement.includes(TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_CUTOVERS_TABLE)) {
        return "CLAIM CAPTURED";
      }
      if (/^CREATE TABLE/i.test(statement)) return "CREATE TABLE";
      if (/^CREATE INDEX/i.test(statement)) return "CREATE INDEX";
      if (/^INSERT INTO .*task_assignment_acknowledgements/i.test(statement)) return "SEED PAIRS";
      if (/^DELETE FROM .*baseline_pairs/i.test(statement)) return "DELETE PAIRS";
      if (/^UPDATE .*cutovers/i.test(statement)) return "MARK SEEDED";
      return null;
    };
    expect(statements.map(kind).filter(Boolean)).toEqual([
      "BEGIN GLOBAL SNAPSHOT", "CAPTURE PAIRS", "CAPTURE PAIRS", "MARK GLOBAL CUTOVER", "COMMIT",
      "BEGIN", "CLAIM CAPTURED", "CREATE TABLE", "CREATE INDEX", "SEED PAIRS", "DELETE PAIRS", "MARK SEEDED", "COMMIT",
      "BEGIN", "CLAIM CAPTURED", "CREATE TABLE", "CREATE INDEX", "SEED PAIRS", "DELETE PAIRS", "MARK SEEDED", "COMMIT",
    ]);

    const globalMarker = statements.findIndex((statement) =>
      statement.startsWith(`INSERT INTO ${TASK_ASSIGNMENT_ACKNOWLEDGEMENTS_GLOBAL_CUTOVER_TABLE}`)
    );
    expect(globalMarker).toBeGreaterThan(-1);
    expect(statements[globalMarker + 1], "commit all captured offices before phase-2 DDL").toBe("COMMIT");
    const firstPhaseTwo = statements.findIndex((statement, index) => index > globalMarker && statement === "BEGIN");
    expect(firstPhaseTwo, "materialization begins only after the global capture commits").toBeGreaterThan(
      globalMarker
    );

    // Exercise the actual capture/materialization queries rather than a prose invariant: phase 1 stores
    // the nullable assignment version, and phase 2 seeds only the exact task, assignee and version.
    const capture = statements.find((statement) => /^WITH newly_captured/i.test(statement));
    expect(capture).toContain("baseline_assigned_at");
    expect(capture).toContain("tasks.assigned_at");
    const seed = statements.find((statement) =>
      /^INSERT INTO "office_[^"]+"\.task_assignment_acknowledgements/i.test(statement)
    );
    expect(seed).toContain("baseline.user_id, baseline.baseline_ack_at");
    expect(seed).toMatch(/JOIN "office_dallas"\.tasks AS tasks\s+ON tasks\.id = baseline\.task_id/);
    expect(seed).toContain("tasks.assigned_to = baseline.user_id");
    expect(seed).toContain("tasks.assigned_at IS NOT DISTINCT FROM baseline.baseline_assigned_at");
    const deletePairs = statements.findIndex((statement) => /^DELETE FROM .*baseline_pairs/i.test(statement));
    const markSeeded = statements.findIndex((statement) => /^UPDATE .*cutovers/i.test(statement));
    expect(deletePairs).toBeGreaterThan(-1);
    expect(markSeeded).toBeGreaterThan(deletePairs);
    expect(statements[markSeeded + 1]).toBe("COMMIT");
  });
});
