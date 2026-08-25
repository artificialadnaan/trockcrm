// The 0239 assigned_at backfill, which is a RUNNER STEP rather than SQL in the migration file.
//
// WHY IT IS A STEP. Identical reasoning to the 0233 classification backfill next door, on the same
// table and the same two triggers: the backfill has to disable set_tasks_updated_at and audit_tasks
// around itself, and `ALTER TABLE ... DISABLE TRIGGER` takes a lock that conflicts with task writes.
// runner.ts sends each .sql file as ONE client.query(sql) — one implicit transaction — so a DO block
// doing this per office would hold the first office's lock until the LAST office finished, blocking
// task writes across every tenant during API startup. Per-tenant transactions are not expressible
// inside a migration file, so the work moved here, where each office gets its own transaction.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE. PGlite is a single in-process connection, so it cannot observe
// lock contention or true concurrency — a test claiming to prove "no blocking" would be a guard that
// cannot fire, and none is written here. What IS proved: the dating is correct and in the safe
// direction, updated_at survives it, and — via a recording client — the statement sequence really does
// open and COMMIT one transaction PER OFFICE, closing each before the next is touched. That boundary is
// the actual fix, and it is observable without observing locks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";
import {
  runTasksAssignedAtBackfill,
  buildAssignedAtBackfillStatement,
  ASSIGNED_AT_SUSPENDED_TRIGGERS,
} from "../../src/migrations/tasks-assigned-at-backfill.js";

const COLUMN_MIGRATION = "0239_tasks_assigned_at";
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

/** Years before the migration, so a backfill that used now() cannot pass by coincidence. */
const SEEDED_CREATED_AT = "2019-06-07 08:09:10+00";
/** Any trigger firing during the backfill moves this. */
const SEEDED_UPDATED_AT = "2020-01-02 03:04:05+00";

let pg: PGlite;
const asClient = () => pg as unknown as Parameters<typeof runTasksAssignedAtBackfill>[0];

async function seedOffices(schemas: readonly string[]) {
  await pg.exec(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $fn$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $fn$ LANGUAGE plpgsql;

    CREATE TABLE IF NOT EXISTS public.audit_log_probe (id bigserial PRIMARY KEY, action text NOT NULL);
    CREATE OR REPLACE FUNCTION audit_trigger_probe()
    RETURNS TRIGGER AS $fn$
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
  }
  await pg.exec(`DELETE FROM public.audit_log_probe;`);
}

/** The file half: adds the column (and nothing else). */
async function applyColumnMigration() {
  await pg.exec(migrationSql(COLUMN_MIGRATION));
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("tasks.assigned_at backfill — what it writes", () => {
  it("dates an existing task from its CREATION, in every office", async () => {
    await seedOffices(OFFICES);
    await applyColumnMigration();

    await runTasksAssignedAtBackfill(asClient());

    for (const schema of OFFICES) {
      const result = await pg.query<{ same: boolean; assigned_at: string }>(
        `SELECT assigned_at = created_at AS same, assigned_at::text FROM ${schema}.tasks`
      );
      expect(result.rows[0]?.same, `${schema}: assigned_at must equal created_at`).toBe(true);
      // Named explicitly: the DIRECTION of the guess is the decision. now() would post-date every
      // acknowledgement 0235 seeded and re-notify the company about work they have already seen.
      expect(result.rows[0]?.assigned_at).toContain("2019-06-07");
    }
  });

  // Asserted on a row the backfill DOES rewrite — the column default is now(), so every seeded row
  // starts out needing the update. Asserting on a row it skips would pass whatever the code did.
  it("leaves updated_at untouched — the contacts 'Last touch' column depends on it", async () => {
    await seedOffices(OFFICES);
    await applyColumnMigration();

    await runTasksAssignedAtBackfill(asClient());

    for (const schema of OFFICES) {
      const result = await pg.query<{ updated_at: string }>(`SELECT updated_at::text FROM ${schema}.tasks`);
      expect(result.rows[0]?.updated_at, `${schema}: set_tasks_updated_at fired`).toContain("2020-01-02");
    }
  });

  it("writes no audit rows for a column no person edited", async () => {
    await seedOffices(OFFICES);
    await applyColumnMigration();

    await runTasksAssignedAtBackfill(asClient());

    const result = await pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.audit_log_probe`);
    expect(result.rows[0]?.n).toBe(0);
  });

  it("re-enables both triggers afterwards", async () => {
    await seedOffices(OFFICES);
    await applyColumnMigration();

    await runTasksAssignedAtBackfill(asClient());

    for (const schema of OFFICES) {
      const result = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_trigger
          WHERE tgrelid = '${schema}.tasks'::regclass AND tgenabled = 'D'`
      );
      expect(result.rows[0]?.n, `${schema}: a trigger was left disabled`).toBe(0);
    }
  });

  it("is idempotent — a second run rewrites nothing and moves no dates", async () => {
    await seedOffices(OFFICES);
    await applyColumnMigration();
    await runTasksAssignedAtBackfill(asClient());

    await expect(runTasksAssignedAtBackfill(asClient())).resolves.toBeUndefined();

    for (const schema of OFFICES) {
      const result = await pg.query<{ same: boolean; updated_at: string }>(
        `SELECT assigned_at = created_at AS same, updated_at::text FROM ${schema}.tasks`
      );
      expect(result.rows[0]?.same, schema).toBe(true);
      expect(result.rows[0]?.updated_at, schema).toContain("2020-01-02");
    }
  });

  it("skips a partially-provisioned office instead of taking the others down with it", async () => {
    await seedOffices(OFFICES);
    await applyColumnMigration();
    // Has a tasks table but never received the column — 0239's own loop skips such a schema too.
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS office_halfbuilt;
      CREATE TABLE office_halfbuilt.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);

    await expect(runTasksAssignedAtBackfill(asClient())).resolves.toBeUndefined();

    const dallas = await pg.query<{ same: boolean }>(
      `SELECT assigned_at = created_at AS same FROM office_dallas.tasks`
    );
    expect(dallas.rows[0]?.same).toBe(true);
  });

  // The silent no-op the index pre-step actually shipped once: called before the column exists, every
  // office fails the readiness test, nothing is written, and the migration is recorded as applied.
  it("refuses to run before the column exists rather than quietly doing nothing", async () => {
    await seedOffices(OFFICES);

    await expect(runTasksAssignedAtBackfill(asClient())).rejects.toThrow(/must run AFTER/);
  });

  it("does not raise when there are no office schemas at all", async () => {
    await expect(runTasksAssignedAtBackfill(asClient())).resolves.toBeUndefined();
  });

  it("refuses a schema name that is not a well-formed office schema", () => {
    for (const bad of ["public", "office_dallas; DROP TABLE tasks", 'office_"dallas', "office_Dallas"]) {
      expect(() => buildAssignedAtBackfillStatement(bad), bad).toThrow(/Invalid office schema name/);
    }
  });
});

describe("tasks.assigned_at backfill — one transaction PER OFFICE", () => {
  /**
   * A client that records the statement SEQUENCE without executing it.
   *
   * PGlite is one in-process connection and cannot show lock contention, but the sequence is exactly
   * what distinguishes "a transaction per office" from "one transaction for all of them", and that
   * distinction is the fix.
   */
  function recordingClient(schemas: string[]) {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim());
      if (sql.includes("information_schema.schemata")) {
        return { rows: schemas.map((schema_name) => ({ schema_name })) };
      }
      if (sql.includes("information_schema.columns") || sql.includes("information_schema.tables")) {
        void params;
        return { rows: [{ n: 1 }] };
      }
      return { rows: [] };
    });
    return { client: { query } as never, statements };
  }

  const kind = (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return sql;
    if (sql.includes("DISABLE TRIGGER")) return "DISABLE";
    if (sql.includes("ENABLE TRIGGER")) return "ENABLE";
    if (sql.startsWith("UPDATE")) return "UPDATE";
    return null;
  };

  it("opens and commits a transaction around EACH office", async () => {
    const { client, statements } = recordingClient(["office_dallas", "office_atlanta"]);

    await runTasksAssignedAtBackfill(client);

    const shape = statements.map(kind).filter(Boolean);
    // Two identical, closed cycles — not one BEGIN wrapping everything.
    expect(shape).toEqual([
      "BEGIN", "DISABLE", "DISABLE", "UPDATE", "ENABLE", "ENABLE", "COMMIT",
      "BEGIN", "DISABLE", "DISABLE", "UPDATE", "ENABLE", "ENABLE", "COMMIT",
    ]);
  });

  // The property that actually releases the locks: office N's COMMIT must precede office N+1's BEGIN.
  // A single transaction spanning every office is precisely what this forbids.
  it("commits each office BEFORE touching the next", async () => {
    const { client, statements } = recordingClient([...OFFICES]);

    await runTasksAssignedAtBackfill(client);

    const shape = statements.map(kind).filter(Boolean) as string[];
    expect(shape.filter((s) => s === "BEGIN")).toHaveLength(OFFICES.length);
    expect(shape.filter((s) => s === "COMMIT")).toHaveLength(OFFICES.length);

    let open = 0;
    for (const s of shape) {
      if (s === "BEGIN") open += 1;
      if (s === "COMMIT") open -= 1;
      // Never two transactions open at once, i.e. never one spanning offices.
      expect(open, `after ${s}: ${shape.join(",")}`).toBeLessThanOrEqual(1);
      expect(open).toBeGreaterThanOrEqual(0);
    }
    expect(open).toBe(0);
  });

  it("names each office's own schema in its statements", async () => {
    const { client, statements } = recordingClient(["office_dallas", "office_atlanta"]);

    await runTasksAssignedAtBackfill(client);

    expect(statements.some((s) => s.includes('"office_dallas".tasks'))).toBe(true);
    expect(statements.some((s) => s.includes('"office_atlanta".tasks'))).toBe(true);
  });

  it("disables and re-enables the triggers in mirrored order, inside the transaction", async () => {
    const { client, statements } = recordingClient(["office_dallas"]);

    await runTasksAssignedAtBackfill(client);

    const triggers = statements
      .filter((s) => s.includes("TRIGGER"))
      .map((s) => `${s.includes("DISABLE") ? "off" : "on"}:${ASSIGNED_AT_SUSPENDED_TRIGGERS.find((t) => s.includes(t))}`);
    expect(triggers).toEqual([
      "off:set_tasks_updated_at",
      "off:audit_tasks",
      "on:audit_tasks",
      "on:set_tasks_updated_at",
    ]);
  });

  it("rolls back the office it failed on rather than leaving a transaction open", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      if (sql.includes("information_schema.schemata")) return { rows: [{ schema_name: "office_dallas" }] };
      if (sql.includes("information_schema.columns") || sql.includes("information_schema.tables")) {
        return { rows: [{ n: 1 }] };
      }
      if (sql.includes("DISABLE TRIGGER audit_tasks")) throw new Error("boom");
      return { rows: [] };
    });

    await expect(runTasksAssignedAtBackfill({ query } as never)).rejects.toThrow("boom");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
});
