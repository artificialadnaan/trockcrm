// The tasks(assigned_to, source, status, due_date) index, and the FIRST-RUN ordering that makes it safe.
//
// THE DEFECT THIS SUITE EXISTS FOR. The runner builds this index CONCURRENTLY in a pre-step so that API
// boot never holds a write-blocking lock on `tasks` across every office at once. That pre-step can only
// build an index on a column that already exists — so while the column and the index lived in the SAME
// migration, the pre-step found no `source` column on the very first deploy, skipped every schema, and
// the plain CREATE INDEX inside the migration's DO block did the real build instead: inside the single
// transaction the runner sends the file as, holding locks across all offices, during boot, on the table
// people are complaining is overloaded. The second deploy worked perfectly, which is exactly why it
// would not have been noticed.
//
// The fix is an ordering one: 0233 adds the column and backfills, and the index is a SEPARATE migration
// that runs afterwards, by which point the pre-step's precondition holds. The first test below is the
// one that pins it — it asserts 0233 builds no index at all, which is what makes the blocking path
// impossible rather than merely unlikely.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";
import {
  TASK_SOURCE_INDEX_MIGRATION,
  TASK_SOURCE_INDEX_NAME,
  runTaskSourceIndexMigration,
} from "../../src/migrations/task-source-index.js";

const COLUMN_MIGRATION = "0233_task_source_classification";
const INDEX_MIGRATION = "0237_tasks_assigned_source_status_index";

/** THREE offices: office_dallas is also written by the literal TENANT_SCHEMA block, so it alone cannot
 *  prove the tenant loop reached every schema. */
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

let pg: PGlite;

/** The pre-step is written against `pg.Client`; PGlite's query() is shape-compatible for what it uses. */
const asClient = () => pg as unknown as Parameters<typeof runTaskSourceIndexMigration>[0];

async function indexOffices() {
  const result = await pg.query<{ schemaname: string }>(
    `SELECT schemaname FROM pg_indexes WHERE indexname = $1 ORDER BY schemaname`,
    [TASK_SOURCE_INDEX_NAME]
  );
  return result.rows.map((r) => r.schemaname);
}

async function columnExists(schema: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'source'`,
    [schema]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

/** A pre-0233 tenant: a tasks table with both triggers and NO `source` column anywhere. */
async function seedVirginOffices(schemas: readonly string[]) {
  await pg.exec(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $fn$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $fn$ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION audit_trigger_probe()
    RETURNS TRIGGER AS $fn$ BEGIN RETURN NEW; END; $fn$ LANGUAGE plpgsql;
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

beforeEach(async () => {
  pg = new PGlite();
});

describe("first-run ordering — the column migration never builds the index", () => {
  // THE GUARD. On a first deploy every office is in exactly this state, and 0233 executes as ONE
  // statement inside one transaction. If it builds the index here, it does so under a write-blocking
  // lock held across every office until the last one finishes.
  it("0233 adds the column and backfills but creates NO index", async () => {
    await seedVirginOffices(OFFICES);

    await pg.exec(migrationSql(COLUMN_MIGRATION));

    for (const schema of OFFICES) {
      expect(await columnExists(schema), `${schema} column`).toBe(true);
    }
    expect(await indexOffices(), "0233 must not build the index").toEqual([]);
  });

  // The precondition the pre-step needs, and the thing that was false before the split: by the time the
  // index migration is reached, 0233 has already added the column, so the pre-step has something to
  // build on and does the work CONCURRENTLY rather than skipping.
  it("the pre-step builds the index in EVERY office on a first run, before its file executes", async () => {
    await seedVirginOffices(OFFICES);
    await pg.exec(migrationSql(COLUMN_MIGRATION));

    await runTaskSourceIndexMigration(asClient());

    expect(await indexOffices()).toEqual([...OFFICES].sort());
  });

  // ...and the file is then only a marker: it no-ops on tenants the pre-step already served, while
  // still being what the office provisioner replays for schemas created after this deploy.
  it("the index migration file is a no-op once the pre-step has built it", async () => {
    await seedVirginOffices(OFFICES);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await runTaskSourceIndexMigration(asClient());

    await expect(pg.exec(migrationSql(INDEX_MIGRATION))).resolves.toBeDefined();

    expect(await indexOffices()).toEqual([...OFFICES].sort());
    const all = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = $1`,
      [TASK_SOURCE_INDEX_NAME]
    );
    expect(all.rows[0]?.n).toBe(OFFICES.length);
  });

  // The full first-deploy sequence the runner performs, in order, with nothing pre-existing.
  it("end-to-end first deploy leaves every office with the column and a valid index", async () => {
    await seedVirginOffices(OFFICES);

    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await runTaskSourceIndexMigration(asClient());
    await pg.exec(migrationSql(INDEX_MIGRATION));

    for (const schema of OFFICES) {
      expect(await columnExists(schema), schema).toBe(true);
    }
    const valid = await pg.query<{ schemaname: string; indisvalid: boolean }>(
      `SELECT n.nspname AS schemaname, i.indisvalid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 ORDER BY n.nspname`,
      [TASK_SOURCE_INDEX_NAME]
    );
    expect(valid.rows.map((r) => r.schemaname)).toEqual([...OFFICES].sort());
    for (const row of valid.rows) expect(row.indisvalid, row.schemaname).toBe(true);
  });

  // A SECOND deploy (everything already in place) must change nothing and must not error.
  it("is idempotent across a re-run of the whole sequence", async () => {
    await seedVirginOffices(OFFICES);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await runTaskSourceIndexMigration(asClient());
    await pg.exec(migrationSql(INDEX_MIGRATION));

    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await runTaskSourceIndexMigration(asClient());
    await expect(pg.exec(migrationSql(INDEX_MIGRATION))).resolves.toBeDefined();

    expect(await indexOffices()).toEqual([...OFFICES].sort());
  });
});

describe("the index migration's own guards", () => {
  it("names the file the runner dispatches on", () => {
    expect(TASK_SOURCE_INDEX_MIGRATION).toBe(`${INDEX_MIGRATION}.sql`);
  });

  it("indexes the columns the tabs actually query, in order", async () => {
    await seedVirginOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await pg.exec(migrationSql(INDEX_MIGRATION));

    const def = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='office_dallas' AND indexname=$1`,
      [TASK_SOURCE_INDEX_NAME]
    );
    expect(def.rows[0]?.indexdef).toContain("assigned_to, source, status, due_date");
  });

  // A schema with no tasks table must be skipped by BOTH halves rather than aborting the deploy for
  // every other tenant.
  it("skips a schema with no tasks table, in the file and in the pre-step alike", async () => {
    await seedVirginOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);
    await pg.exec(migrationSql(COLUMN_MIGRATION));

    await expect(runTaskSourceIndexMigration(asClient())).resolves.toBeUndefined();
    await expect(pg.exec(migrationSql(INDEX_MIGRATION))).resolves.toBeDefined();
    expect(await indexOffices()).toEqual(["office_dallas"]);
  });

  // Defensive: if 0233 has not run for a schema, there is no column to index. BOTH halves must skip
  // rather than raising on the undefined column and taking the whole migration down with it — and they
  // must skip the SAME schemas, or the file blocking-builds somewhere the pre-step declined to.
  it("skips a schema whose source column is missing — in the pre-step", async () => {
    await seedVirginOffices(["office_dallas"]);
    // deliberately NOT running 0233
    await expect(runTaskSourceIndexMigration(asClient())).resolves.toBeUndefined();
    expect(await indexOffices()).toEqual([]);
  });

  // The file half of the same guard. office_dallas is normal here (0233 applied) because the
  // TENANT_SCHEMA block is literal SQL against that schema and legitimately assumes its predecessor
  // ran — every tenant block makes that assumption. The stripped schema is office_houston, which only
  // the tenant LOOP reaches, so this isolates the loop's guard: one office missing 0233 must not stop
  // the other offices getting their index.
  it("skips a schema whose source column is missing — in the file's tenant loop", async () => {
    await seedVirginOffices(["office_dallas", "office_houston"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await pg.exec(`ALTER TABLE office_houston.tasks DROP COLUMN source;`);

    await expect(pg.exec(migrationSql(INDEX_MIGRATION))).resolves.toBeDefined();
    expect(await indexOffices()).toEqual(["office_dallas"]);
  });

  // The provisioner takes indexOf on the FIRST occurrence of the marker, so a marker named in a prose
  // comment above the real block would truncate what a new office receives.
  it("has exactly one TENANT_SCHEMA block, replayable on its own", async () => {
    const raw = migrationSql(INDEX_MIGRATION);
    expect(raw.split("-- TENANT_SCHEMA_START")).toHaveLength(2);
    expect(raw.split("-- TENANT_SCHEMA_END")).toHaveLength(2);

    const block = raw.split("-- TENANT_SCHEMA_START")[1].split("-- TENANT_SCHEMA_END")[0];
    await seedVirginOffices(["office_dallas"]);
    await pg.exec(migrationSql(COLUMN_MIGRATION));
    await pg.exec(block);

    expect(await indexOffices()).toEqual(["office_dallas"]);
  });
});
