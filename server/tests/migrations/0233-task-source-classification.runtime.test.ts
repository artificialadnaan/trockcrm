// Executes migration 0233 FROM DISK against a real Postgres (PGlite).
//
// 0233 adds `tasks.source`. It does NOTHING ELSE, and the tests asserting that absence are the point of
// this suite as much as the ones asserting the column.
//
// THE INVARIANT: nothing that takes a lock on `tasks` may run inside a migration file's single
// transaction across every office. runner.ts sends each .sql file as ONE client.query(sql), so a DO
// block looping every office_% schema holds every lock it takes until the LAST office finishes —
// per-tenant transactions are not expressible inside a migration file at all. `tasks` is written by the
// rules engine, the email queue, two crons, deal reassignment and every person using the New Task form,
// so a lock held across tenants means task writes progressively blocking in every office, on deploy.
//
// Two things therefore live in runner steps instead, each taking one transaction PER OFFICE:
//   * the classification backfill (it must DISABLE two triggers) -> task-source-backfill.runtime.test
//   * the index (it must be built CONCURRENTLY)  -> 0237-tasks-assigned-source-status-index.runtime.test
// The behavioural coverage for the backfill lives in that suite, against the code that now performs it.
//
// The remaining checks below are about the tenant loop reaching every schema, and about the file
// staying additive.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0233_task_source_classification";
const INDEX_NAME = "tasks_assigned_source_status_idx";

/**
 * THREE offices, deliberately. office_dallas is also written by the literal TENANT_SCHEMA block at the
 * foot of the file, so it comes out correct even if the tenant loop is broken — a two-office fixture
 * (dallas + one) still passes with the loop clamped to a single schema, because between them the one
 * the loop reaches and the one the block reaches cover both. A third office has no second source: only
 * the loop can give it the column and the CHECK.
 */
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

async function columnExists(pg: PGlite, schema: string, table: string, column: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

async function sourceOf(pg: PGlite, schema: string, description: string) {
  const result = await pg.query<{ source: string }>(
    `SELECT source FROM ${schema}.tasks WHERE description = $1`,
    [description]
  );
  expect(result.rows, `fixture row "${description}"`).toHaveLength(1);
  return result.rows[0]?.source;
}

/** A pre-0233 tenant: a tasks table carrying both triggers 0001 puts on it. */
async function seedOffices(pg: PGlite, schemas: readonly string[]) {
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

describe("migration 0233 — tasks.source", () => {
  let pg: PGlite;

  beforeEach(() => {
    pg = new PGlite();
  });

  afterEach(async () => {
    await pg.close();
  });

  it("adds the column to EVERY office schema, not just the first", async () => {
    await seedOffices(pg, OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      expect(await columnExists(pg, schema, "tasks", "source"), schema).toBe(true);
    }
  });

  // Executed, not grepped: a CHECK constraint that exists but does not constrain is the failure this
  // catches, and reading its definition out of the catalog could not tell the difference.
  it("REJECTS a source outside the two allowed values, in EVERY office schema", async () => {
    await seedOffices(pg, OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await expect(
        pg.exec(`INSERT INTO ${schema}.tasks (title, source) VALUES ('bogus', 'imported')`),
        schema
      ).rejects.toThrow();
      await expect(
        pg.exec(`INSERT INTO ${schema}.tasks (title, source) VALUES ('a', 'manual'), ('b', 'automated')`),
        schema
      ).resolves.toBeDefined();
    }
  });

  it("defaults new rows to 'automated' — the safer wrong answer for an unclassified row", async () => {
    await seedOffices(pg, OFFICES);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await pg.exec(
        `INSERT INTO ${schema}.tasks (title, description) VALUES ('t', 'no source supplied')`
      );
      expect(await sourceOf(pg, schema, "no source supplied"), schema).toBe("automated");
    }
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices(pg, ["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const columns = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='tasks' AND column_name='source'`
    );
    expect(columns.rows[0]?.n).toBe(1);
    const checks = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname='tasks_source_check'`
    );
    expect(checks.rows[0]?.n).toBe(1);
  });

  it("skips a schema that has no tasks table, instead of failing the whole migration", async () => {
    await seedOffices(pg, ["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnExists(pg, "office_dallas", "tasks", "source")).toBe(true);
  });

  // The provisioner replays ONLY the marked block for offices created after this deploy. If it drifts
  // from the loop, a new office comes up missing the column and every task write there 500s.
  it("has a TENANT_SCHEMA block that produces the same column and CHECK as the loop", async () => {
    const raw = migrationSql(MIGRATION);
    // The provisioner takes indexOf on the FIRST occurrence, so a marker named in a prose comment above
    // the real block would truncate what a new office receives.
    expect(raw.split("-- TENANT_SCHEMA_START")).toHaveLength(2);
    expect(raw.split("-- TENANT_SCHEMA_END")).toHaveLength(2);

    const block = raw.split("-- TENANT_SCHEMA_START")[1].split("-- TENANT_SCHEMA_END")[0];
    await seedOffices(pg, ["office_dallas"]);
    await pg.exec(block);

    expect(await columnExists(pg, "office_dallas", "tasks", "source")).toBe(true);
    await expect(
      pg.exec(`INSERT INTO office_dallas.tasks (title, source) VALUES ('bogus', 'imported')`)
    ).rejects.toThrow();
  });

  it("builds NO index in any office — that is 0237's job, via a CONCURRENTLY pre-step", async () => {
    // One office: this is a property of the FILE, and the regex check below already covers the loop and
    // the provisioner block together. Executing it here proves the two agree.
    await seedOffices(pg, ["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const found = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = $1`,
      [INDEX_NAME]
    );
    expect(found.rows[0]?.n).toBe(0);
  });
});

// STRUCTURAL, and labelled as such. PGlite is a single in-process connection and cannot observe lock
// contention, so no test here claims to prove "this does not block" — that would be a guard that cannot
// fire. What IS checkable, and what actually went wrong twice, is whether the lock-taking statements
// are present in the file at all. They must not be: inside the file's one transaction they would be
// held across every office.
describe("migration 0233 — the file stays additive (structural)", () => {
  /** The file's executable SQL, with comments removed so prose may still explain the reasoning. */
  const executableSql = () =>
    migrationSql(MIGRATION)
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

  /**
   * Every ALTER TABLE action the file performs, normalised. ALTER TABLE is the only way this file can
   * take a lock on a tenant table, so enumerating its actions enumerates the risk.
   */
  const alterTableActions = () => {
    const sql = executableSql();
    const actions: string[] = [];
    const re = /ALTER\s+TABLE\s+[^\s]+\s+([\s\S]*?);/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) {
      actions.push(match[1].replace(/\s+/g, " ").trim());
    }
    return actions;
  };

  // AN ALLOWLIST, NOT A DENYLIST — this is the guard's second version, and the reason for the change is
  // the bug it missed. The first version named three things the file must not CONTAIN (DISABLE TRIGGER,
  // CREATE INDEX, UPDATE). A bare `ADD CONSTRAINT ... CHECK` contains none of them and does the exact
  // damage they were listed for: it validates every existing row while holding ACCESS EXCLUSIVE, and
  // because the DO block is one transaction the first office's lock is held while every later office is
  // scanned. That is the second statement to walk past the denylist, so the question is inverted: every
  // lock-taking action the file performs must be named here as safe, and anything new fails until
  // somebody has justified it.
  //
  // What qualifies as safe, and why:
  //   * ADD COLUMN IF NOT EXISTS ... DEFAULT <constant>  — metadata-only in PG11+, no row scan.
  //   * ADD CONSTRAINT ... CHECK ... NOT VALID           — skips the scan of existing rows; still
  //     enforced on every new insert and update. The scan happens later, per office, via
  //     VALIDATE CONSTRAINT in a runner step, which takes only SHARE UPDATE EXCLUSIVE and does not
  //     block reads or writes.
  const ALLOWED_ACTIONS = [
    /^ADD COLUMN IF NOT EXISTS source varchar\(20\) NOT NULL DEFAULT 'automated'$/i,
    /^ADD CONSTRAINT tasks_source_check CHECK \(source IN \('manual', 'automated'\)\) NOT VALID$/i,
  ];

  it("performs ONLY allowlisted, lock-safe ALTER TABLE actions", () => {
    const actions = alterTableActions();
    // Two per site (the tenant loop and the provisioner block), so four in total. If this count moves,
    // a statement was added or removed and the reviewer should look at it.
    expect(actions, "expected ADD COLUMN + ADD CONSTRAINT, in the loop and the tenant block").toHaveLength(4);

    for (const action of actions) {
      const allowed = ALLOWED_ACTIONS.some((pattern) => pattern.test(action));
      expect(allowed, `not an allowlisted lock-safe action: ALTER TABLE ... ${action}`).toBe(true);
    }
  });

  // The specific property the allowlist encodes, asserted on its own so a failure names the reason
  // rather than just "did not match a regex".
  it("never validates the CHECK inline — that scan holds ACCESS EXCLUSIVE across every office", () => {
    for (const action of alterTableActions()) {
      if (/ADD CONSTRAINT/i.test(action)) {
        expect(action, "an ADD CONSTRAINT ... CHECK without NOT VALID scans every row under a lock")
          .toMatch(/NOT VALID$/i);
      }
      expect(action, "VALIDATE CONSTRAINT belongs in the per-office runner step, not this file")
        .not.toMatch(/VALIDATE CONSTRAINT/i);
    }
  });

  it("contains no DISABLE TRIGGER — that lock would be held across every tenant", () => {
    expect(migrationSql(MIGRATION)).not.toMatch(/\bDISABLE\s+TRIGGER\b/i);
    expect(migrationSql(MIGRATION)).not.toMatch(/\bENABLE\s+TRIGGER\b/i);
  });

  it("contains no CREATE INDEX — that build would be held across every tenant", () => {
    expect(migrationSql(MIGRATION)).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
  });

  // The backfill's UPDATEs are the long-running part; in the file they would extend every office's lock
  // window to the whole run. Comments are stripped first so the header may still explain the reasoning.
  it("runs no UPDATE — the backfill is a per-office runner step", () => {
    const withoutComments = migrationSql(MIGRATION)
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(withoutComments).not.toMatch(/\bUPDATE\s+\S+\.tasks\b/i);
    expect(withoutComments).not.toMatch(/\bUPDATE\s+%1\$I\b/i);
  });
});
