// The 0233 classification backfill, which is a RUNNER STEP rather than SQL in the migration file.
//
// WHY IT IS A STEP. The backfill has to disable set_tasks_updated_at and audit_tasks around itself, and
// `ALTER TABLE ... DISABLE TRIGGER` takes a lock that conflicts with task writes. runner.ts sends each
// .sql file as ONE client.query(sql) — one implicit transaction — so a DO block doing this per office
// would hold the first office's lock until the LAST office finished, blocking task writes across every
// tenant on the deploy that ships the feature. Per-tenant transactions are not expressible inside a
// migration file, so the work moved here, where each office gets its own transaction.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE. PGlite is a single in-process connection, so it cannot observe
// lock contention or true concurrency — a test claiming to prove "no blocking" would be a guard that
// cannot fire, and none is written here. What IS proved: the classification is correct, updated_at
// survives it, and — via a recording client — the statement sequence really does open and COMMIT one
// transaction PER OFFICE, closing each before the next is touched. That boundary is the actual fix, and
// it is observable without observing locks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";
import {
  runTaskSourceBackfill,
  buildClassifyStatement,
  buildRepairStatement,
  BACKFILL_SUSPENDED_TRIGGERS,
} from "../../src/migrations/task-source-backfill.js";

const COLUMN_MIGRATION = "0233_task_source_classification";
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

const HUMAN = "11111111-1111-1111-1111-111111111111";
const SEEDED_UPDATED_AT = "2020-01-02 03:04:05+00";

let pg: PGlite;
const asClient = () => pg as unknown as Parameters<typeof runTaskSourceBackfill>[0];

async function sourceOf(schema: string, description: string) {
  const result = await pg.query<{ source: string }>(
    `SELECT source FROM ${schema}.tasks WHERE description = $1`,
    [description]
  );
  expect(result.rows, `fixture row "${description}"`).toHaveLength(1);
  return result.rows[0].source;
}

async function seedOffices(schemas: readonly string[]) {
  await pg.exec(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $fn$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $fn$ LANGUAGE plpgsql;

    CREATE TABLE IF NOT EXISTS public.audit_log_probe (
      id bigserial PRIMARY KEY, table_name text NOT NULL, action text NOT NULL
    );
    CREATE OR REPLACE FUNCTION audit_trigger_probe()
    RETURNS TRIGGER AS $fn$
    BEGIN
      INSERT INTO public.audit_log_probe (table_name, action) VALUES (TG_TABLE_NAME, TG_OP);
      RETURN NEW;
    END; $fn$ LANGUAGE plpgsql;
  `);
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(500) NOT NULL,
        description text,
        type varchar(50) NOT NULL DEFAULT 'manual',
        priority varchar(20) NOT NULL DEFAULT 'normal',
        status varchar(20) NOT NULL DEFAULT 'pending',
        assigned_to uuid,
        created_by uuid,
        origin_rule varchar(120),
        entity_snapshot jsonb,
        contact_id uuid,
        due_date date,
        is_test_data boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TRIGGER set_tasks_updated_at
        BEFORE UPDATE ON ${schema}.tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      CREATE TRIGGER audit_tasks
        AFTER INSERT OR UPDATE OR DELETE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION audit_trigger_probe();
    `);
  }
}

/**
 * One row per production write shape. `updated_at` is set in the INSERT, never by a follow-up UPDATE:
 * set_tasks_updated_at is BEFORE UPDATE and overwrites it unconditionally, so an UPDATE could not seed
 * a past timestamp at all and the assertion below would be comparing two values that differ only by how
 * long the backfill took.
 */
async function seedTaskShapes(schema: string) {
  await pg.exec(`
    INSERT INTO ${schema}.tasks (description, title, type, created_by, origin_rule, entity_snapshot, updated_at) VALUES
      ('rule-engine', 'Deal has stalled', 'system', NULL, 'deal_stalled', NULL, '${SEEDED_UPDATED_AT}'),
      ('email-queue', 'Classify email: Re: roof', 'inbound_email', '${HUMAN}', 'email_assignment_queue', NULL, '${SEEDED_UPDATED_AT}'),
      ('ai-disconnect', 'AI disconnect follow-up', 'manual', NULL, 'ai_disconnect_admin_task', NULL, '${SEEDED_UPDATED_AT}'),
      ('revision-routing', 'Address estimate revision', 'system', '${HUMAN}', 'deal_estimate_revision_requested', NULL, '${SEEDED_UPDATED_AT}'),
      ('hand-typed', 'Call the roofer back', 'manual', '${HUMAN}', NULL, NULL, '${SEEDED_UPDATED_AT}'),
      ('assignment-task', 'New Deal Assignment', 'manual', '${HUMAN}', NULL,
        '{"entityType":"deal","assignedAt":"2024-05-01T00:00:00.000Z","actorUserId":"${HUMAN}"}', '${SEEDED_UPDATED_AT}'),
      ('human-titled-like-assignment', 'New Lead Assignment', 'manual', '${HUMAN}', NULL, '{"note":"typed by hand"}', '${SEEDED_UPDATED_AT}'),
      ('human-titled-null-snapshot', 'New Deal Assignment', 'manual', '${HUMAN}', NULL, NULL, '${SEEDED_UPDATED_AT}'),
      ('orphan', 'Imported from somewhere', 'manual', NULL, NULL, NULL, '${SEEDED_UPDATED_AT}');
    DELETE FROM public.audit_log_probe;
  `);
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("task source backfill — classification", () => {
  it("classifies every known production task shape", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");

    await runTaskSourceBackfill(asClient());

    // Four machine shapes. email-queue and revision-routing both carry a real human on created_by, so
    // `created_by IS NULL` could never have separated them — origin_rule is what does.
    expect(await sourceOf("office_dallas", "rule-engine")).toBe("automated");
    expect(await sourceOf("office_dallas", "email-queue")).toBe("automated");
    expect(await sourceOf("office_dallas", "ai-disconnect")).toBe("automated");
    expect(await sourceOf("office_dallas", "revision-routing")).toBe("automated");

    expect(await sourceOf("office_dallas", "hand-typed")).toBe("manual");
    expect(await sourceOf("office_dallas", "assignment-task")).toBe("automated");
    // The title ALONE must not be enough, or a person's task is misfiled by its wording.
    expect(await sourceOf("office_dallas", "human-titled-like-assignment")).toBe("manual");
    // ...and a NULL snapshot makes the jsonb test NULL, not false — COALESCE keeps it on the human side.
    expect(await sourceOf("office_dallas", "human-titled-null-snapshot")).toBe("manual");
    // Nothing identifies this row, so it keeps the safe default rather than being guessed into Manual.
    expect(await sourceOf("office_dallas", "orphan")).toBe("automated");
  });

  it("classifies EVERY office, not just the first", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    for (const schema of OFFICES) await seedTaskShapes(schema);

    await runTaskSourceBackfill(asClient());

    for (const schema of OFFICES) {
      expect(await sourceOf(schema, "hand-typed"), schema).toBe("manual");
      expect(await sourceOf(schema, "assignment-task"), schema).toBe("automated");
    }
  });

  // THE ONE THAT MATTERS. `hand-typed` is a row the backfill genuinely rewrites, so the UPDATE
  // definitely touches it; without the DISABLE wrapper set_tasks_updated_at stamps NOW() and every
  // contact linked to a task reports the migration timestamp as its "Last touch".
  it("leaves updated_at untouched on rows it rewrites", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");

    await runTaskSourceBackfill(asClient());

    const after = await pg.query<{ description: string; updated_at: Date }>(
      `SELECT description, updated_at FROM office_dallas.tasks ORDER BY description`
    );
    const seeded = new Date(SEEDED_UPDATED_AT).toISOString();
    for (const row of after.rows) {
      expect(row.updated_at.toISOString(), row.description).toBe(seeded);
    }
  });

  it("writes no audit rows", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");

    await runTaskSourceBackfill(asClient());

    const audited = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM public.audit_log_probe WHERE table_name = 'tasks'`
    );
    expect(audited.rows[0]?.n).toBe(0);
  });

  it("re-enables both triggers when it is done", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");

    await runTaskSourceBackfill(asClient());

    const enabled = await pg.query<{ tgname: string; tgenabled: string }>(
      `SELECT t.tgname, t.tgenabled FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='office_dallas' AND c.relname='tasks' AND NOT t.tgisinternal
        ORDER BY t.tgname`
    );
    expect(enabled.rows.map((r) => r.tgname)).toEqual(["audit_tasks", "set_tasks_updated_at"]);
    for (const row of enabled.rows) expect(row.tgenabled, row.tgname).toBe("O");

    // Proven by behaviour, not just the catalog letter: a normal UPDATE must move updated_at again.
    await pg.exec(`UPDATE office_dallas.tasks SET title='edited' WHERE description='hand-typed'`);
    const touched = await pg.query<{ updated_at: Date }>(
      `SELECT updated_at FROM office_dallas.tasks WHERE description='hand-typed'`
    );
    expect(touched.rows[0]!.updated_at.toISOString()).not.toBe(new Date(SEEDED_UPDATED_AT).toISOString());
  });

  // "Touch only rows whose value actually changes." xmin changes whenever a row version is written,
  // which is how this tells "left alone" from "rewritten to the value it already held" — a distinction
  // no SELECT of `source` could make. Catches classifying reassignment rows in two passes instead of one.
  it("rewrites no row twice — a converged schema is left physically untouched", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");
    await runTaskSourceBackfill(asClient());

    const first = await pg.query<{ description: string; xmin: string }>(
      `SELECT description, xmin::text AS xmin FROM office_dallas.tasks ORDER BY description`
    );
    await runTaskSourceBackfill(asClient());
    const second = await pg.query<{ description: string; xmin: string }>(
      `SELECT description, xmin::text AS xmin FROM office_dallas.tasks ORDER BY description`
    );

    expect(second.rows.map((r) => `${r.description}:${r.xmin}`)).toEqual(
      first.rows.map((r) => `${r.description}:${r.xmin}`)
    );
  });

  it("repairs a reassignment task an interrupted run left classified as manual", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");
    await runTaskSourceBackfill(asClient());

    await pg.exec(`UPDATE office_dallas.tasks SET source='manual' WHERE description='assignment-task'`);
    await runTaskSourceBackfill(asClient());

    expect(await sourceOf("office_dallas", "assignment-task")).toBe("automated");
    expect(await sourceOf("office_dallas", "hand-typed")).toBe("manual");
  });

  // The ordering trap, made loud. Called before 0233's file, every office fails the readiness test, the
  // loop classifies nothing, and the migration is recorded as applied — a silent no-op. That is exactly
  // how the index pre-step's first-deploy bug survived review, so this one refuses instead.
  it("REFUSES to run before the column migration, rather than silently classifying nothing", async () => {
    await seedOffices(OFFICES);
    // deliberately NOT running 0233

    await expect(runTaskSourceBackfill(asClient())).rejects.toThrow(/ran before the required column existed/);
  });

  // ...but a single partially-provisioned office among healthy ones is a real state, and must not trip
  // the ordering guard: the healthy offices still get classified.
  it("still classifies the healthy offices when ONE is missing the column", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    for (const schema of OFFICES) await seedTaskShapes(schema);
    await pg.exec(`ALTER TABLE office_houston.tasks DROP COLUMN source;`);

    await expect(runTaskSourceBackfill(asClient())).resolves.toBeUndefined();
    expect(await sourceOf("office_dallas", "hand-typed")).toBe("manual");
    expect(await sourceOf("office_atlanta", "hand-typed")).toBe("manual");
  });

  it("skips a schema that never received the column, instead of failing every other office", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(runTaskSourceBackfill(asClient())).resolves.toBeUndefined();
    expect(await sourceOf("office_dallas", "hand-typed")).toBe("manual");
  });

  // Unconditional on purpose: a schema missing the trigger must abort loudly, having written nothing,
  // rather than quietly backfilling with set_tasks_updated_at live.
  it("REFUSES to run against a tasks table missing the updated_at trigger, and writes nothing", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");
    await pg.exec(`DROP TRIGGER set_tasks_updated_at ON office_dallas.tasks;`);

    await expect(runTaskSourceBackfill(asClient())).rejects.toThrow(/set_tasks_updated_at/);

    // The office's transaction rolled back, so nothing was reclassified.
    expect(await sourceOf("office_dallas", "hand-typed")).toBe("automated");
  });
});

// The mechanism itself is proven in per-office-step.runtime.test.ts. What these guard is that the task
// backfill is actually WIRED to it — a future edit that inlines its own loop here would still classify
// correctly and would still be the outage the mechanism exists to prevent.
describe("task source CHECK — deferred by the migration, validated by the step", () => {
  async function convalidated(schema: string) {
    const r = await pg.query<{ convalidated: boolean }>(
      `SELECT c.convalidated FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = $1 AND c.conname = 'tasks_source_check'`,
      [schema]
    );
    expect(r.rows, `${schema} constraint`).toHaveLength(1);
    return r.rows[0].convalidated;
  }

  // The migration adds it NOT VALID so the row scan does not run under a lock held across every office.
  it("0233 leaves the constraint NOT VALID", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(COLUMN_MIGRATION));

    for (const schema of OFFICES) expect(await convalidated(schema), schema).toBe(false);
  });

  // ...but deferring it is only acceptable because something finishes the job. Without this the column
  // would sit permanently unvalidated and the constraint would be a half-guarantee nobody noticed.
  it("the step validates it afterwards, in EVERY office", async () => {
    await seedOffices(OFFICES);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    for (const schema of OFFICES) await seedTaskShapes(schema);

    await runTaskSourceBackfill(asClient());

    for (const schema of OFFICES) expect(await convalidated(schema), schema).toBe(true);
  });

  // NOT VALID defers the scan of EXISTING rows only — new writes are rejected from the moment it exists,
  // which is what makes the deferral safe rather than a hole between the two deploys.
  it("rejects a bad value even while still NOT VALID", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    expect(await convalidated("office_dallas")).toBe(false);

    await expect(
      pg.exec(`INSERT INTO office_dallas.tasks (title, source) VALUES ('bogus', 'imported')`)
    ).rejects.toThrow();
  });

  it("is idempotent — validating an already-validated constraint is a no-op", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await seedTaskShapes("office_dallas");
    await runTaskSourceBackfill(asClient());

    await expect(runTaskSourceBackfill(asClient())).resolves.toBeUndefined();
    expect(await convalidated("office_dallas")).toBe(true);
  });
});

describe("task source backfill — wired to the per-office mechanism", () => {
  /**
   * A recording stand-in for pg.Client. This is the honest way to assert the transaction BOUNDARY:
   * PGlite is one in-process connection and cannot show lock contention, but the statement SEQUENCE is
   * exactly what distinguishes "a transaction per office" from "one transaction for all of them", and
   * that sequence is the fix.
   */
  function recordingClient(schemas: string[]) {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim());
      if (sql.includes("information_schema.schemata")) {
        return { rows: schemas.map((schema_name) => ({ schema_name })) };
      }
      if (sql.includes("information_schema.tables") || sql.includes("information_schema.columns")) {
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
    if (sql.includes("VALIDATE CONSTRAINT")) return "VALIDATE";
    return null;
  };

  it("opens and commits a transaction around EACH office, in BOTH passes", async () => {
    const { client, statements } = recordingClient(["office_dallas", "office_atlanta"]);

    await runTaskSourceBackfill(client);

    const shape = statements.map(kind).filter(Boolean);
    // Two passes over the offices — classification, then the deferred CHECK validation — and every one
    // of the four cycles is individually opened and closed. Never one BEGIN wrapping any of it.
    expect(shape).toEqual([
      "BEGIN", "DISABLE", "DISABLE", "UPDATE", "UPDATE", "ENABLE", "ENABLE", "COMMIT",
      "BEGIN", "DISABLE", "DISABLE", "UPDATE", "UPDATE", "ENABLE", "ENABLE", "COMMIT",
      "BEGIN", "VALIDATE", "COMMIT",
      "BEGIN", "VALIDATE", "COMMIT",
    ]);
  });

  // The property that actually releases the locks: office N's COMMIT must precede office N+1's BEGIN.
  // A single transaction spanning every office is precisely what this forbids.
  it("commits each office BEFORE touching the next", async () => {
    const { client, statements } = recordingClient(["office_dallas", "office_atlanta", "office_houston"]);

    await runTaskSourceBackfill(client);

    const shape = statements.map(kind).filter(Boolean) as string[];
    // Three offices across two passes.
    expect(shape.filter((s) => s === "BEGIN")).toHaveLength(6);
    expect(shape.filter((s) => s === "COMMIT")).toHaveLength(6);

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

    await runTaskSourceBackfill(client);

    expect(statements.some((s) => s.includes('"office_dallas".tasks'))).toBe(true);
    expect(statements.some((s) => s.includes('"office_atlanta".tasks'))).toBe(true);
  });

  it("rolls back the office it failed on rather than leaving a transaction open", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      if (sql.includes("information_schema.schemata")) return { rows: [{ schema_name: "office_dallas" }] };
      if (sql.includes("information_schema.")) return { rows: [{ n: 1 }] };
      if (sql.includes("DISABLE TRIGGER audit_tasks")) throw new Error("boom");
      return { rows: [] };
    });

    await expect(runTaskSourceBackfill({ query } as never)).rejects.toThrow("boom");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("suspends exactly the two triggers that would corrupt or bloat, and restores them in reverse", async () => {
    expect([...BACKFILL_SUSPENDED_TRIGGERS]).toEqual(["set_tasks_updated_at", "audit_tasks"]);
  });
});
