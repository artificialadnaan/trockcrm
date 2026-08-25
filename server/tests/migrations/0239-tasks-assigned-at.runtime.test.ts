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

  // AN ALLOWLIST, NOT A DENYLIST — mirroring 0233's guard, and for the reason that one was rewritten.
  // A denylist names the statements seen to be dangerous so far; a bare `ADD CONSTRAINT ... CHECK`
  // walked past 0233's first version while doing exactly what it forbade. So the question is inverted:
  // every lock-taking action this file performs must be named here as safe, and anything new fails
  // until somebody has justified it. 0239 currently performs exactly one kind.
  //
  // Why ADD COLUMN ... DEFAULT now() qualifies, which is less obvious than it looks: PG11+ makes an
  // ADD COLUMN with a default metadata-only, storing the evaluated value as a "missing value" instead
  // of rewriting the table — but ONLY when the default contains no VOLATILE function. now() is STABLE,
  // so it is evaluated once at ALTER time and takes the fast path. random() or clock_timestamp() would
  // not, and would rewrite every row under ACCESS EXCLUSIVE across every office in one transaction.
  // That distinction is proved below rather than argued from the manual.
  const alterTableActions = () => {
    const actions: string[] = [];
    const re = /ALTER\s+TABLE\s+[^\s]+\s+([\s\S]*?);/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(migrationSql(MIGRATION))) !== null) {
      actions.push(match[1].replace(/\s+/g, " ").trim());
    }
    return actions;
  };

  const ALLOWED_ACTIONS = [
    /^ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now\(\)$/i,
  ];

  it("performs ONLY allowlisted, lock-safe ALTER TABLE actions", () => {
    const actions = alterTableActions();
    // One per site: the tenant loop and the provisioner block. If this count moves, a statement was
    // added or removed and a reviewer should look at it.
    expect(actions, "expected ADD COLUMN in the loop and in the tenant block").toHaveLength(2);

    for (const action of actions) {
      const allowed = ALLOWED_ACTIONS.some((pattern) => pattern.test(action));
      expect(allowed, `not an allowlisted lock-safe action: ALTER TABLE ... ${action}`).toBe(true);
    }
  });

  // EXECUTED, not reasoned about. atthasmissing is true only when PG took the metadata-only path and
  // stored the default as a missing value; a volatile default rewrites the table instead and leaves it
  // false. This is the difference between an instant ALTER and one holding ACCESS EXCLUSIVE over every
  // row in every office, and it turns on a property of the default expression that no amount of reading
  // the statement reveals.
  it("adds the column WITHOUT rewriting the table — the default takes PG's fast path", async () => {
    await seedOffices(OFFICES);
    await pg.exec(`INSERT INTO office_dallas.tasks (title) VALUES ('pre-existing row')`);

    await pg.exec(migrationSql(MIGRATION));

    const result = await pg.query<{ atthasmissing: boolean }>(
      `SELECT atthasmissing FROM pg_attribute
        WHERE attrelid = 'office_dallas.tasks'::regclass AND attname = 'assigned_at'`
    );
    expect(
      result.rows[0]?.atthasmissing,
      "the ADD COLUMN rewrote the table instead of storing a missing value — check the default is not volatile"
    ).toBe(true);
  });

  // THE BACKFILL MUST NOT COME BACK. Restoring it would restore the cross-tenant lock hold this PR
  // moved it out to avoid, and it would read as a perfectly ordinary DO block in review. Kept as
  // explicit negatives alongside the allowlist because each names its own reason on failure.
  it("runs no UPDATE, and no trigger juggling — both belong to the runner step", async () => {
    const source = migrationSql(MIGRATION)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    expect(source, "an UPDATE here runs inside one transaction spanning every office").not.toMatch(
      /\bUPDATE\b/i
    );
    expect(source, "this lock is held across every tenant").not.toMatch(/\bDISABLE\s+TRIGGER\b/i);
    expect(source).not.toMatch(/\bENABLE\s+TRIGGER\b/i);
    expect(source, "an index build would be held across every tenant").not.toMatch(
      /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i
    );
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
