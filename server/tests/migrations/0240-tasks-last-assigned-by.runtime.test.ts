// Executes migration 0240 FROM DISK against a real Postgres (PGlite).
//
// 0240 adds `tasks.last_assigned_by` — WHO handed this task to its current assignee.
//
// WHY A THIRD COLUMN IS NOT THE `created_by` / `origin_rule` / `type` MESS REPEATING ITSELF. Those
// three overlap because each was pressed into answering "who made this" and none of them actually
// does. These do not overlap: `created_by` is who typed the task into existence, `assigned_at`
// (0239, sibling branch) is WHEN it last changed hands, and `last_assigned_by` is WHO handed it over. A
// reassigned task has a different answer for the first and the third, which is the entire defect this
// migration exists to fix — the reply went to the original creator instead of the person actually
// waiting on it.
//
// THE BACKFILL IS THE RISKY PART, and it is why this suite exists. `tasks` carries
// set_tasks_updated_at, and the contacts list reads MAX(tasks.updated_at) straight through as a
// contact's "Last touch" — the same trap 0233 documented. Letting the trigger fire here would stamp
// every contact that has ever had a task with this migration's timestamp, and the original values are
// not recoverable.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0240_tasks_last_assigned_by";

/** Three offices: office_dallas is also written by the literal TENANT_SCHEMA block, so only the
 *  third proves the DO-loop reached beyond the first schema. */
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

const CREATOR = "11111111-1111-1111-1111-111111111111";
const REASSIGNER = "22222222-2222-2222-2222-222222222222";
const ASSIGNEE = "33333333-3333-3333-3333-333333333333";
const STRANGER = "44444444-4444-4444-4444-444444444444";
const SEEDED_UPDATED_AT = "2020-01-02 03:04:05+00";

let pg: PGlite;

async function columnExists(schema: string, column: string) {
  const r = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='tasks' AND column_name=$2`,
    [schema, column]
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

async function indexDef(schema: string, name: string) {
  const r = await pg.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2`, [schema, name]
  );
  return r.rows[0]?.indexdef ?? null;
}

async function lastAssignedByOf(schema: string, description: string) {
  const r = await pg.query<{ last_assigned_by: string | null }>(
    `SELECT last_assigned_by FROM ${schema}.tasks WHERE description = $1`, [description]
  );
  expect(r.rows, `fixture "${description}"`).toHaveLength(1);
  return r.rows[0]!.last_assigned_by;
}

async function seedOffices(schemas: string[]) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY, display_name text);
    INSERT INTO public.users (id, display_name) VALUES
      ('${CREATOR}','Creator'), ('${REASSIGNER}','Reassigner'), ('${ASSIGNEE}','Assignee')
    ON CONFLICT DO NOTHING;

    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $fn$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $fn$ LANGUAGE plpgsql;

    CREATE TABLE IF NOT EXISTS public.audit_log_probe (
      id bigserial PRIMARY KEY, table_name text NOT NULL, action text NOT NULL
    );
    CREATE OR REPLACE FUNCTION audit_trigger_probe() RETURNS TRIGGER AS $fn$
    BEGIN INSERT INTO public.audit_log_probe (table_name, action) VALUES (TG_TABLE_NAME, TG_OP);
      RETURN NEW; END; $fn$ LANGUAGE plpgsql;
  `);

  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(500) NOT NULL,
        description text,
        assigned_to uuid,
        created_by uuid REFERENCES public.users(id),
        source varchar(20) NOT NULL DEFAULT 'automated',
        last_reply_at timestamptz,
        assigner_ack_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- 0234's index, which 0240 replaces with the assigner-scoped one.
      CREATE INDEX tasks_creator_awaiting_ack_idx
        ON ${schema}.tasks (created_by, last_reply_at DESC)
        WHERE last_reply_at IS NOT NULL
          AND (assigner_ack_at IS NULL OR assigner_ack_at < last_reply_at);
      CREATE TRIGGER set_tasks_updated_at BEFORE UPDATE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      CREATE TRIGGER audit_tasks AFTER INSERT OR UPDATE OR DELETE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION audit_trigger_probe();
    `);
  }
}

async function seedTasks(schema: string) {
  await pg.exec(`
    INSERT INTO ${schema}.tasks (description, title, assigned_to, created_by, source, updated_at) VALUES
      -- a person's task: the creator IS the assigner until it changes hands
      ('hand-typed', 'Call the roofer', '${ASSIGNEE}', '${CREATOR}', 'manual', '${SEEDED_UPDATED_AT}'),
      -- rules engine: nobody assigned it, so nobody is waiting on a reply to it
      ('rule-engine', 'Deal has stalled', '${ASSIGNEE}', NULL, 'automated', '${SEEDED_UPDATED_AT}'),
      -- the email queue stamps a REAL human on created_by for a machine task; the backfill carries
      -- that across, which is correct: that human is the closest thing to an assigner it has
      ('email-queue', 'Classify email', '${ASSIGNEE}', '${CREATOR}', 'automated', '${SEEDED_UPDATED_AT}');
    DELETE FROM public.audit_log_probe;
  `);
}

beforeEach(async () => { pg = new PGlite(); });

describe("migration 0240 — tasks.last_assigned_by", () => {
  it("adds the column to EVERY office schema", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));
    for (const s of OFFICES) expect(await columnExists(s, "last_assigned_by"), s).toBe(true);
  });

  // NO BACKFILL, BY DESIGN. Readers resolve COALESCE(last_assigned_by, created_by), so every
  // historical row already reports the right assigner without being rewritten. Proving the ABSENCE of
  // churn matters as much as proving a backfill would: `tasks` carries set_tasks_updated_at, which
  // the contacts list reads through as "Last touch", and a rewrite here is the one operation on this
  // table with an irreversible failure mode.
  it("rewrites NO existing row — the column starts NULL and history is untouched", async () => {
    await seedOffices(["office_dallas"]);
    await seedTasks("office_dallas");

    const before = await pg.query<{ description: string; xmin: string; updated_at: Date }>(
      `SELECT description, xmin::text AS xmin, updated_at FROM office_dallas.tasks ORDER BY description`
    );
    await pg.exec(migrationSql(MIGRATION));
    const after = await pg.query<{ description: string; xmin: string; updated_at: Date; last_assigned_by: string | null }>(
      `SELECT description, xmin::text AS xmin, updated_at, last_assigned_by FROM office_dallas.tasks ORDER BY description`
    );

    // xmin, not just the value: it is what separates "left alone" from "rewritten to the same value".
    expect(after.rows.map((r) => `${r.description}:${r.xmin}`)).toEqual(
      before.rows.map((r) => `${r.description}:${r.xmin}`)
    );
    const seeded = new Date(SEEDED_UPDATED_AT).toISOString();
    for (const row of after.rows) {
      expect(row.updated_at.toISOString(), row.description).toBe(seeded);
      // NULL means "never reassigned" — a fact worth being able to read, not a gap.
      expect(row.last_assigned_by, row.description).toBeNull();
    }
  });

  it("REFUSES an last_assigned_by that is not a real user", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(
      pg.exec(`INSERT INTO office_dallas.tasks (title, last_assigned_by) VALUES ('x','${STRANGER}')`)
    ).rejects.toThrow();
  });

  // The awaiting-me predicate now scopes by ASSIGNER, so the index has to follow it or the query
  // filters after the scan over every task the person ever created.
  it("replaces the creator index with an assigner-scoped one, in EVERY office", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const s of OFFICES) {
      const def = await indexDef(s, "tasks_assigner_awaiting_ack_idx");
      expect(def, `${s} assigner index`).toBeTruthy();
      // On the RESOLUTION, not the bare column. The query scopes by
      // COALESCE(last_assigned_by, created_by); an index on `last_assigned_by` alone still "mentions
      // the column" and still exists, but the planner cannot use it for that predicate -- so the
      // bucket silently falls back to a scan over every task the person ever created. The two must be
      // spelled identically or the index is decorative.
      expect(def!.toLowerCase(), `${s} must index the COALESCE expression`).toContain("coalesce");
      expect(def!, s).toMatch(/last_assigned_by/);
      expect(def!, `${s} the fallback half of the resolution`).toMatch(/created_by/);
      expect(def!, s).toMatch(/last_reply_at/);
      expect(def!.toLowerCase(), s).toContain("where");
      expect(def!, s).toMatch(/assigner_ack_at/);
      // ...and the one it replaces is gone, rather than both being maintained on every write.
      expect(await indexDef(s, "tasks_creator_awaiting_ack_idx"), `${s} old index`).toBeNull();
    }
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices([...OFFICES]);
    await seedTasks("office_dallas");
    await pg.exec(migrationSql(MIGRATION));
    const first = await pg.query<{ description: string; last_assigned_by: string | null; xmin: string }>(
      `SELECT description, last_assigned_by, xmin::text AS xmin FROM office_dallas.tasks ORDER BY description`
    );

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const second = await pg.query<{ description: string; last_assigned_by: string | null; xmin: string }>(
      `SELECT description, last_assigned_by, xmin::text AS xmin FROM office_dallas.tasks ORDER BY description`
    );
    // xmin, not just the value: a converged schema must be left PHYSICALLY untouched, which is what
    // separates "left alone" from "rewritten to the value it already held".
    expect(second.rows.map((r) => `${r.description}:${r.last_assigned_by}:${r.xmin}`)).toEqual(
      first.rows.map((r) => `${r.description}:${r.last_assigned_by}:${r.xmin}`)
    );
  });

  it("skips a schema that has no tasks table", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnExists("office_dallas", "last_assigned_by")).toBe(true);
  });

  it("has a TENANT_SCHEMA block matching the loop", async () => {
    const raw = migrationSql(MIGRATION);
    const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
    expect(block).toBeTruthy();
    expect(raw.split("-- TENANT_SCHEMA_START")).toHaveLength(2);
    expect(raw.split("-- TENANT_SCHEMA_END")).toHaveLength(2);

    await seedOffices(["office_dallas"]);
    await pg.exec(block!);

    expect(await columnExists("office_dallas", "last_assigned_by")).toBe(true);
    const def = await indexDef("office_dallas", "tasks_assigner_awaiting_ack_idx");
    expect(def).toBeTruthy();
    expect(def!.toLowerCase()).toContain("coalesce");
    expect(def!).toMatch(/created_by/);
    expect(def!).toMatch(/assigner_ack_at/);
    expect(await indexDef("office_dallas", "tasks_creator_awaiting_ack_idx")).toBeNull();
  });
});
