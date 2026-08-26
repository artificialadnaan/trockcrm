// Executes migration 0239 FROM DISK against a real Postgres (PGlite).
//
// 0239 adds `tasks.assigned_at` — when the task last changed hands — which is what lets an
// acknowledgement answer ONE assignment rather than a task forever.
//
// THE RUNNER installs the file's global fence, then adds the nullable column, its default and its
// rolling-deploy trigger one office at a time. Dating untouched rows and restoring NOT NULL is a runner step
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
import {
  extractTasksAssignedAtVersioningGlobals,
  runTasksAssignedAtBackfill,
  runTasksAssignedAtVersioning,
} from "../../src/migrations/tasks-assigned-at-backfill.js";

const MIGRATION = "0239_tasks_assigned_at";
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

/** The moment every seeded row was last touched. Any trigger firing during the backfill moves this. */
const SEEDED_UPDATED_AT = "2020-01-02 03:04:05+00";
const SEEDED_CREATED_AT = "2019-06-07 08:09:10+00";
const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const USER_C = "00000000-0000-4000-8000-000000000003";

let pg: PGlite;

async function seedOffices(schemas: readonly string[]) {
  await pg.exec(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $fn$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $fn$ LANGUAGE plpgsql;

    CREATE TABLE IF NOT EXISTS public.offices (slug text PRIMARY KEY);
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
        source text NOT NULL DEFAULT 'manual',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TRIGGER set_tasks_updated_at
        BEFORE UPDATE ON ${schema}.tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      CREATE TRIGGER audit_tasks
        AFTER INSERT OR UPDATE OR DELETE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION audit_trigger_probe();

      INSERT INTO ${schema}.tasks (title, assigned_to, created_at, updated_at)
        VALUES ('historic task', '${USER_A}', '${SEEDED_CREATED_AT}', '${SEEDED_UPDATED_AT}');
    `);
    await pg.exec(`DELETE FROM public.audit_log_probe;`);
  }
}

/**
 * The tenant shape an API image with #1107/0240 but without #1108/0239 provisions.
 *
 * Kept in SQL next to the race tests so the missing capability is visible: last_assigned_by exists,
 * assigned_at does not. The ordinary 0001 row triggers are present because the repair must suspend
 * them around its defensive created_at fill rather than corrupting audit/Last-touch evidence.
 */
function legacyProvisionSql(slug: string) {
  const schema = `office_${slug}`;

  return `
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(500) NOT NULL,
      assigned_to uuid,
      source text NOT NULL DEFAULT 'automated',
      last_assigned_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER set_tasks_updated_at
      BEFORE UPDATE ON ${schema}.tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER audit_tasks
      AFTER INSERT OR UPDATE OR DELETE ON ${schema}.tasks
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_probe();
  `;
}

const asBackfillClient = () =>
  pg as unknown as Parameters<typeof runTasksAssignedAtBackfill>[0];
const asVersioningClient = () =>
  pg as unknown as Parameters<typeof runTasksAssignedAtVersioning>[0];

/** The runner path: globals/fence first, then bounded existing-office versioning. */
async function applyVersioningMigration() {
  await pg.exec(extractTasksAssignedAtVersioningGlobals(migrationSql(MIGRATION)));
  await runTasksAssignedAtVersioning(asVersioningClient());
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0239 — tasks.assigned_at", () => {
  it("adds the column to EVERY office schema, not just the first", async () => {
    await seedOffices(OFFICES);
    await applyVersioningMigration();

    for (const schema of OFFICES) {
      const result = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'assigned_at'`,
        [schema]
      );
      expect(result.rows[0]?.n, schema).toBe(1);
    }
  });

  it("lets an old-image worker INSERT before the runner restores the final default", async () => {
    await seedOffices(OFFICES);
    await applyVersioningMigration();

    for (const schema of OFFICES) {
      // Both columns use the transaction-stable now(), so an old insert remains self-creation-shaped.
      await pg.exec(`INSERT INTO ${schema}.tasks (title) VALUES ('written by an old worker')`);
      const result = await pg.query<{ same: boolean }>(
        `SELECT assigned_at = created_at AS same
           FROM ${schema}.tasks
          WHERE title = 'written by an old worker'`
      );
      expect(result.rows[0]?.same, schema).toBe(true);
    }
  });

  it("installs the assignment-stamp trigger in EVERY existing office", async () => {
    await seedOffices(OFFICES);
    await applyVersioningMigration();

    for (const schema of OFFICES) {
      const result = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM pg_trigger
          WHERE tgrelid = '${schema}.tasks'::regclass
            AND tgname = 'stamp_tasks_assigned_at'
            AND NOT tgisinternal`
      );
      expect(result.rows[0]?.n, schema).toBe(1);
    }
  });

  it("installs the rolling-image actor guard in EVERY existing office", async () => {
    await seedOffices(OFFICES);
    await applyVersioningMigration();

    for (const schema of OFFICES) {
      const result = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM pg_trigger
          WHERE tgrelid = '${schema}.tasks'::regclass
            AND tgname = 'stabilize_tasks_assignment_actor'
            AND NOT tgisinternal`
      );
      expect(result.rows[0]?.n, schema).toBe(1);
    }
  });

  it("keeps the preflight globals separate from the new-office template", () => {
    const source = migrationSql(MIGRATION);
    const globals = extractTasksAssignedAtVersioningGlobals(source);
    const guard = source.indexOf("CREATE CONSTRAINT TRIGGER tasks_assigned_at_on_office_provision");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(globals).toContain("AFTER INSERT ON public.offices");
    expect(globals).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(globals).not.toContain("-- TENANT_SCHEMA_START");
    expect(source).not.toMatch(/\bDO\s+\$tenant\$/i);
  });

  it("repairs a legacy #1107 provisioner at COMMIT, then converges with the runner scan", async () => {
    await seedOffices(["office_dallas"]);
    await applyVersioningMigration();

    // The INSERT is intentionally first, matching createOffice. If the constraint trigger becomes
    // immediate, it fires here before `tasks` exists and this transaction fails. The old image then
    // provisions through 0240 (last_assigned_by exists) but never sees the new 0239 file.
    await pg.exec(`
      BEGIN;
      INSERT INTO public.offices (slug) VALUES ('tulsa');
      ${legacyProvisionSql("tulsa")}
      COMMIT;
    `);

    const repaired = await pg.query<{
      isNullable: string;
      hasDefault: boolean;
      stampTriggers: number;
      actorTriggers: number;
    }>(`
      SELECT
        c.is_nullable AS "isNullable",
        c.column_default IS NOT NULL AS "hasDefault",
        (SELECT COUNT(*)::int FROM pg_trigger
          WHERE tgrelid = 'office_tulsa.tasks'::regclass
            AND tgname = 'stamp_tasks_assigned_at' AND NOT tgisinternal) AS "stampTriggers",
        (SELECT COUNT(*)::int FROM pg_trigger
          WHERE tgrelid = 'office_tulsa.tasks'::regclass
            AND tgname = 'stabilize_tasks_assignment_actor' AND NOT tgisinternal) AS "actorTriggers"
      FROM information_schema.columns c
      WHERE c.table_schema = 'office_tulsa'
       AND c.table_name = 'tasks'
       AND c.column_name = 'assigned_at'
    `);
    expect(repaired.rows[0]).toMatchObject({
      isNullable: "NO",
      hasDefault: true,
      stampTriggers: 1,
      actorTriggers: 1,
    });

    // This office committed after the SQL file's scan and before the ordinary per-office step. Traffic
    // can reach it in that gap, so exercise the old worker's INSERT shape before the helper discovers it.
    // The guard's default must make it self-creation-shaped immediately; the helper must then skip the
    // non-NULL version without firing ordinary row triggers.
    await pg.exec(`
      INSERT INTO office_tulsa.tasks (title, assigned_to)
      VALUES ('legacy worker task', '${USER_A}');
    `);
    const inserted = await pg.query<{ version: string; updatedAt: string; sameAsCreated: boolean }>(
      `SELECT assigned_at::text AS version,
              updated_at::text AS "updatedAt",
              assigned_at = created_at AS "sameAsCreated"
         FROM office_tulsa.tasks`
    );
    expect(inserted.rows[0]?.sameAsCreated).toBe(true);
    await pg.exec(`DELETE FROM public.audit_log_probe`);

    await expect(runTasksAssignedAtBackfill(asBackfillClient())).resolves.toBeUndefined();
    const converged = await pg.query<{ version: string; updatedAt: string; auditRows: number }>(`
      SELECT assigned_at::text AS version,
             updated_at::text AS "updatedAt",
             (SELECT COUNT(*)::int FROM public.audit_log_probe) AS "auditRows"
        FROM office_tulsa.tasks
    `);
    expect(converged.rows[0]).toMatchObject({
      version: inserted.rows[0]?.version,
      updatedAt: inserted.rows[0]?.updatedAt,
      auditRows: 0,
    });

    // The email worker binds app.current_user_id to the RECIPIENT while its rules engine updates an
    // automated task. That value must never become the human assigner merely because the writer leaves
    // last_assigned_by unchanged. assigned_at still advances: the assignment itself is real.
    await pg.exec(`SELECT set_config('app.current_user_id', '${USER_C}', false)`);
    const before = await pg.query<{ version: string }>(
      `SELECT assigned_at::text AS version FROM office_tulsa.tasks`
    );
    await pg.exec(`UPDATE office_tulsa.tasks SET assigned_to = '${USER_B}'`);
    const machineMove = await pg.query<{ actor: string | null; newer: boolean; version: string }>(
      `SELECT last_assigned_by AS actor,
              assigned_at > $1::timestamptz AS newer,
              assigned_at::text AS version
         FROM office_tulsa.tasks`,
      [before.rows[0]?.version]
    );
    expect(machineMove.rows[0]?.actor).toBeNull();
    expect(machineMove.rows[0]?.newer).toBe(true);

    // No-op restoration remains source-agnostic. A stale legacy shape that supplies an actor for an
    // already-current assignee cannot transfer the reply loop, even on an automated row.
    await pg.exec(`
      UPDATE office_tulsa.tasks
         SET assigned_to = '${USER_B}', last_assigned_by = '${USER_A}'
    `);
    const machineNoOp = await pg.query<{ actor: string | null; version: string }>(
      `SELECT last_assigned_by AS actor, assigned_at::text AS version FROM office_tulsa.tasks`
    );
    expect(machineNoOp.rows[0]?.actor).toBeNull();
    expect(machineNoOp.rows[0]?.version).toBe(machineMove.rows[0]?.version);
  });

  it("fails closed when constraints are forced before a tenant tasks table exists", async () => {
    await seedOffices(["office_dallas"]);
    await applyVersioningMigration();

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

  // The migration file is now global functions/fence plus the one-office template. Existing-office
  // trigger DDL is deliberately absent: it is lock-conflicting and belongs to the per-office helper.
  const tenantTemplateSource = () => {
    const source = migrationSql(MIGRATION);
    const markerStart = source.indexOf("-- TENANT_SCHEMA_START");
    const markerEnd = source.indexOf("-- TENANT_SCHEMA_END", markerStart);
    return source.slice(markerStart, markerEnd);
  };

  const alterTableActions = () => {
    const actions: string[] = [];
    const re = /ALTER\s+TABLE\s+[^\s]+\s+([\s\S]*?);/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(tenantTemplateSource())) !== null) {
      actions.push(match[1].replace(/\s+/g, " ").trim());
    }
    return actions;
  };

  const ALLOWED_ACTIONS = [
    /^ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now\(\)$/i,
  ];

  it("keeps the migration file to the one-office template ALTER", () => {
    const actions = alterTableActions();
    expect(actions, "expected only the new-office template ALTER").toHaveLength(1);

    for (const action of actions) {
      const allowed = ALLOWED_ACTIONS.some((pattern) => pattern.test(action));
      expect(allowed, `not an allowlisted lock-safe action: ALTER TABLE ... ${action}`).toBe(true);
    }
  });

  // Existing rows must remain NULL until the per-office step dates them. NULL is what distinguishes
  // untouched history from a handoff the compatibility trigger stamps during the deploy window; a
  // DEFAULT here would make those cases indistinguishable and let the backfill erase the handoff.
  it("leaves existing history NULL for the deploy-safe backfill discriminator", async () => {
    await seedOffices(OFFICES);
    await pg.exec(`INSERT INTO office_dallas.tasks (title) VALUES ('pre-existing row')`);

    await applyVersioningMigration();

    const result = await pg.query<{ nulls: number; atthasmissing: boolean }>(
      `SELECT
         (SELECT COUNT(*)::int FROM office_dallas.tasks WHERE assigned_at IS NULL) AS nulls,
         atthasmissing
       FROM pg_attribute
       WHERE attrelid = 'office_dallas.tasks'::regclass AND attname = 'assigned_at'`
    );
    expect(result.rows[0]?.nulls).toBe(2);
    expect(result.rows[0]?.atthasmissing, "the staged column unexpectedly carries a missing default").toBe(false);
  });

  it("contains no existing-office cross-tenant loop", () => {
    const source = migrationSql(MIGRATION)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    expect(source).not.toMatch(/\bDO\s+\$tenant\$/i);
  });

  it("runs existing-office setup in one short transaction per office", async () => {
    const statements: string[] = [];
    const query = async (statement: string) => {
      statements.push(statement.trim());
      if (statement.includes("information_schema.schemata")) {
        return { rows: [{ schema_name: "office_dallas" }, { schema_name: "office_atlanta" }] };
      }
      if (statement.includes("information_schema.tables") || statement.includes("information_schema.columns")) {
        return { rows: [{ n: 1 }] };
      }
      return { rows: [] };
    };

    await runTasksAssignedAtVersioning({ query } as never);

    const shape = statements.filter((statement) =>
      statement === "BEGIN" || statement === "COMMIT" || statement.startsWith("ALTER TABLE") ||
      statement.startsWith("DROP TRIGGER") || statement.startsWith("CREATE TRIGGER")
    );
    expect(shape.filter((statement) => statement === "BEGIN")).toHaveLength(2);
    expect(shape.filter((statement) => statement === "COMMIT")).toHaveLength(2);
    let open = 0;
    for (const statement of shape) {
      if (statement === "BEGIN") open += 1;
      if (statement === "COMMIT") open -= 1;
      expect(open, statement).toBeGreaterThanOrEqual(0);
      expect(open, statement).toBeLessThanOrEqual(1);
    }
    expect(shape.filter((statement) => statement.startsWith("DROP TRIGGER"))).toHaveLength(4);
    expect(shape.filter((statement) => statement.startsWith("CREATE TRIGGER"))).toHaveLength(4);
  });

  it("leaves updated_at alone, because it writes no rows at all", async () => {
    await seedOffices(OFFICES);
    await applyVersioningMigration();

    for (const schema of OFFICES) {
      const result = await pg.query<{ unchanged: boolean }>(
        `SELECT updated_at = $1::timestamptz AS unchanged FROM ${schema}.tasks`,
        [SEEDED_UPDATED_AT]
      );
      expect(result.rows[0]?.unchanged, `${schema}: migration wrote a task row`).toBe(true);
    }
  });

  it("writes no audit rows", async () => {
    await seedOffices(OFFICES);
    await applyVersioningMigration();

    const result = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.audit_log_probe`);
    expect(result.rows[0]?.n).toBe(0);
  });

  it("is idempotent — a second run neither errors nor touches a row", async () => {
    await seedOffices(OFFICES);
    await applyVersioningMigration();
    await expect(applyVersioningMigration()).resolves.toBeUndefined();

    for (const schema of OFFICES) {
      const result = await pg.query<{ unchanged: boolean }>(
        `SELECT updated_at = $1::timestamptz AS unchanged FROM ${schema}.tasks`,
        [SEEDED_UPDATED_AT]
      );
      expect(result.rows[0]?.unchanged, `${schema}: a repeated migration wrote a task row`).toBe(true);
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
    // In production the global trigger function was installed when 0239 ran. Model that before the
    // office provisioner later replays only the tenant block.
    await seedOffices(["office_dallas"]);
    await applyVersioningMigration();
    await seedOffices(["office_tulsa"]);
    await pg.exec(`DELETE FROM office_tulsa.tasks`);
    await pg.exec(block.replace(/office_dallas/g, "office_tulsa"));
    // At a real upgraded createOffice commit, the permanent public.offices fence sees this already-
    // provisioned shape after the marker ran. Fire that event too: its staged repair must be idempotent
    // with the current provisioner, not merely able to rescue the legacy one above.
    await pg.exec(`
      BEGIN;
      INSERT INTO public.offices (slug) VALUES ('tulsa');
      COMMIT;
    `);

    const result = await pg.query<{ n: number; isNullable: string; hasDefault: boolean }>(
      `SELECT
         COUNT(*)::int AS n,
         MAX(is_nullable) AS "isNullable",
         BOOL_AND(column_default IS NOT NULL) AS "hasDefault"
       FROM information_schema.columns
       WHERE table_schema = 'office_tulsa' AND table_name = 'tasks' AND column_name = 'assigned_at'`
    );
    expect(result.rows[0]?.n).toBe(1);
    expect(result.rows[0]?.isNullable).toBe("NO");
    expect(result.rows[0]?.hasDefault).toBe(true);

    const trigger = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_trigger
        WHERE tgrelid = 'office_tulsa.tasks'::regclass
          AND tgname = 'stamp_tasks_assigned_at' AND NOT tgisinternal`
    );
    expect(trigger.rows[0]?.n).toBe(1);

    const actorTrigger = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_trigger
        WHERE tgrelid = 'office_tulsa.tasks'::regclass
          AND tgname = 'stabilize_tasks_assignment_actor' AND NOT tgisinternal`
    );
    expect(actorTrigger.rows[0]?.n).toBe(1);

    // 0240 runs after 0239 on a clean install (and later in this same atomic provisioner transaction).
    // The guard is deliberately column-tolerant until that happens, then becomes active without DDL.
    await pg.exec(`ALTER TABLE office_tulsa.tasks ADD COLUMN last_assigned_by uuid`);
    await pg.exec(`INSERT INTO office_tulsa.tasks (title, assigned_to) VALUES ('new task', '${USER_A}')`);
    await pg.exec(`SELECT set_config('app.current_user_id', '${USER_C}', false)`);
    await pg.exec(`UPDATE office_tulsa.tasks SET assigned_to = '${USER_B}' WHERE title = 'new task'`);
    const stamped = await pg.query<{ newer: boolean; actor: string }>(
      `SELECT assigned_at > created_at AS newer, last_assigned_by AS actor
         FROM office_tulsa.tasks WHERE title = 'new task'`
    );
    expect(stamped.rows[0]?.newer).toBe(true);
    expect(stamped.rows[0]?.actor).toBe(USER_C);
  });

  it("skips an office schema that has no tasks table instead of aborting the deploy", async () => {
    await seedOffices(OFFICES);
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_halfbuilt;`);

    await expect(applyVersioningMigration()).resolves.toBeUndefined();
  });

  it("skips a malformed tasks table without assigned_to before taking a DDL lock", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`
      CREATE SCHEMA office_halfbuilt;
      CREATE TABLE office_halfbuilt.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);

    await expect(applyVersioningMigration()).resolves.toBeUndefined();

    const result = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM information_schema.columns
        WHERE table_schema = 'office_halfbuilt'
          AND table_name = 'tasks'
          AND column_name = 'assigned_at'`
    );
    expect(result.rows[0]?.n).toBe(0);
  });
});
