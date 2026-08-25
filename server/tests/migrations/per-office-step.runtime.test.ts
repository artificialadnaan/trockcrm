// The reusable per-office migration step.
//
// WHY IT IS SHARED RATHER THAN LOCAL TO ONE MIGRATION. runner.ts sends each .sql file as ONE
// client.query(sql), which Postgres runs as one implicit transaction, so a DO block looping every
// office_% schema holds every lock it takes until the LAST office finishes. Per-tenant transactions are
// not expressible inside a migration file at all. Any migration that needs a lock-taking statement —
// DISABLE TRIGGER, a large UPDATE, anything beyond a metadata-only ALTER — has to run outside the file,
// and it has to commit per office or it has merely moved the same problem.
//
// Four review findings across two reviewers landed on that one constraint, and at least one other
// in-flight migration hits it, so the mechanism lives here and is driven by configuration rather than
// copied. THE TEST THAT MAKES "REUSABLE" MEAN SOMETHING is the second describe block below: it drives
// the same helper against a completely different table with different triggers, so a change that
// quietly hard-codes `tasks` fails here rather than in whichever migration adopts it next.
//
// WHAT THIS SUITE CANNOT PROVE. PGlite is a single in-process connection: it cannot observe lock
// contention or concurrency, so nothing here claims to prove "this does not block". The assertions are
// about the transaction BOUNDARY — which is the actual fix — via a recording client, plus real
// execution against PGlite for the behaviour inside each transaction.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runPerOfficeTransactionalStep } from "../../src/migrations/per-office-step.js";

let pg: PGlite;
const asClient = () => pg as unknown as Parameters<typeof runPerOfficeTransactionalStep>[0];

const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

async function seedSchemas(schemas: readonly string[]) {
  await pg.exec(`
    CREATE OR REPLACE FUNCTION bump_touched()
    RETURNS TRIGGER AS $fn$ BEGIN NEW.touched_at = NOW(); RETURN NEW; END; $fn$ LANGUAGE plpgsql;
  `);
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.widgets (
        id serial PRIMARY KEY,
        label text,
        kind text,
        touched_at timestamptz NOT NULL DEFAULT '2020-01-01T00:00:00Z'
      );
      CREATE TRIGGER set_widgets_touched
        BEFORE UPDATE ON ${schema}.widgets FOR EACH ROW EXECUTE FUNCTION bump_touched();
      INSERT INTO ${schema}.widgets (label, kind) VALUES ('a', NULL), ('b', 'preset');
    `);
  }
}

const widgetStep = {
  label: "widget kinds",
  table: "widgets",
  requiredColumn: "kind",
  suspendTriggers: ["set_widgets_touched"] as const,
  buildStatements: (schema: string) => [
    `UPDATE ${schema}.widgets SET kind = 'derived' WHERE kind IS NULL`,
  ],
};

beforeEach(async () => {
  pg = new PGlite();
});

describe("per-office step — behaviour inside each office's transaction", () => {
  it("applies the statements in EVERY office", async () => {
    await seedSchemas(OFFICES);

    await runPerOfficeTransactionalStep(asClient(), widgetStep);

    for (const schema of OFFICES) {
      const rows = await pg.query<{ kind: string }>(
        `SELECT kind FROM ${schema}.widgets ORDER BY id`
      );
      expect(rows.rows.map((r) => r.kind), schema).toEqual(["derived", "preset"]);
    }
  });

  // The reason the mechanism suspends triggers at all: a backfill must not look like a user edit.
  it("suspends the named triggers, so the backfill leaves timestamps alone", async () => {
    await seedSchemas(["office_dallas"]);

    await runPerOfficeTransactionalStep(asClient(), widgetStep);

    const rows = await pg.query<{ touched_at: Date }>(
      `SELECT touched_at FROM office_dallas.widgets ORDER BY id`
    );
    for (const row of rows.rows) {
      expect(row.touched_at.toISOString()).toBe(new Date("2020-01-01T00:00:00Z").toISOString());
    }
  });

  it("restores the triggers afterwards, proven by a normal UPDATE moving the timestamp again", async () => {
    await seedSchemas(["office_dallas"]);
    await runPerOfficeTransactionalStep(asClient(), widgetStep);

    await pg.exec(`UPDATE office_dallas.widgets SET label = 'edited' WHERE id = 1`);

    const row = await pg.query<{ touched_at: Date }>(
      `SELECT touched_at FROM office_dallas.widgets WHERE id = 1`
    );
    expect(row.rows[0]!.touched_at.toISOString()).not.toBe(
      new Date("2020-01-01T00:00:00Z").toISOString()
    );
  });

  it("skips a schema that lacks the table entirely", async () => {
    await seedSchemas(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(runPerOfficeTransactionalStep(asClient(), widgetStep)).resolves.toBeDefined();
  });

  // The ordering trap this mechanism is designed to make loud: called before the migration that adds
  // the column, every office fails the readiness test, nothing is applied, and the migration is
  // recorded as successful. A silent no-op is exactly how the earlier concurrent-index bug survived.
  it("REFUSES to run before the required column exists, rather than silently doing nothing", async () => {
    await seedSchemas(OFFICES);
    for (const schema of OFFICES) await pg.exec(`ALTER TABLE ${schema}.widgets DROP COLUMN kind;`);

    await expect(runPerOfficeTransactionalStep(asClient(), widgetStep)).rejects.toThrow(
      /ran before the required column existed/
    );
  });

  // ...but ONE partially-provisioned office among healthy ones is a real state and must not trip it.
  it("still processes the healthy offices when a single one is missing the column", async () => {
    await seedSchemas(OFFICES);
    await pg.exec(`ALTER TABLE office_houston.widgets DROP COLUMN kind;`);

    const result = await runPerOfficeTransactionalStep(asClient(), widgetStep);

    expect(result.officesProcessed).toBe(2);
    const dallas = await pg.query<{ kind: string }>(`SELECT kind FROM office_dallas.widgets ORDER BY id`);
    expect(dallas.rows[0]?.kind).toBe("derived");
  });
});

describe("per-office step — ONE transaction per office", () => {
  /**
   * A recording stand-in for pg.Client. This is the honest way to assert the transaction BOUNDARY:
   * PGlite cannot show lock contention, but the statement SEQUENCE is exactly what distinguishes "a
   * transaction per office" from "one transaction spanning all of them", and that boundary is the fix.
   */
  function recordingClient(schemas: string[]) {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      if (sql.includes("information_schema.schemata")) {
        return { rows: schemas.map((schema_name) => ({ schema_name })) };
      }
      if (sql.includes("information_schema.tables") || sql.includes("information_schema.columns")) {
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

    await runPerOfficeTransactionalStep(client, widgetStep);

    expect(statements.map(kind).filter(Boolean)).toEqual([
      "BEGIN", "DISABLE", "UPDATE", "ENABLE", "COMMIT",
      "BEGIN", "DISABLE", "UPDATE", "ENABLE", "COMMIT",
    ]);
  });

  // The property that actually releases the locks: office N commits before office N+1 begins. A single
  // transaction spanning every office is precisely what this forbids.
  it("never holds two offices' transactions open at once", async () => {
    const { client, statements } = recordingClient([...OFFICES]);

    await runPerOfficeTransactionalStep(client, widgetStep);

    const shape = statements.map(kind).filter(Boolean) as string[];
    expect(shape.filter((s) => s === "BEGIN")).toHaveLength(3);
    expect(shape.filter((s) => s === "COMMIT")).toHaveLength(3);

    let open = 0;
    for (const s of shape) {
      if (s === "BEGIN") open += 1;
      if (s === "COMMIT") open -= 1;
      expect(open, `after ${s}: ${shape.join(",")}`).toBeLessThanOrEqual(1);
      expect(open).toBeGreaterThanOrEqual(0);
    }
    expect(open).toBe(0);
  });

  it("rolls back the office it failed on rather than leaving a transaction open", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      if (sql.includes("information_schema.schemata")) return { rows: [{ schema_name: "office_dallas" }] };
      if (sql.includes("information_schema.")) return { rows: [{ n: 1 }] };
      if (sql.includes("DISABLE TRIGGER")) throw new Error("boom");
      return { rows: [] };
    });

    await expect(runPerOfficeTransactionalStep({ query } as never, widgetStep)).rejects.toThrow("boom");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
});

// THE REUSABILITY PROOF. Another in-flight migration hits the identical constraint and was pointed at
// this mechanism rather than inventing a second one. Driving it against a different table, a different
// column and a different trigger is what keeps "reusable" true — a change that hard-codes `tasks` or
// `set_tasks_updated_at` breaks here, in this repo, instead of in the migration that adopts it next.
describe("per-office step — genuinely table-agnostic", () => {
  const noteStep = {
    label: "note archiving",
    table: "notes",
    requiredColumn: "archived",
    suspendTriggers: ["set_notes_seen"] as const,
    buildStatements: (schema: string) => [
      `UPDATE ${schema}.notes SET archived = true WHERE body IS NULL`,
    ],
  };

  it("drives a different table, column and trigger with no change to the mechanism", async () => {
    await pg.exec(`
      CREATE OR REPLACE FUNCTION bump_seen()
      RETURNS TRIGGER AS $fn$ BEGIN NEW.seen_at = NOW(); RETURN NEW; END; $fn$ LANGUAGE plpgsql;
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.notes (
        id serial PRIMARY KEY,
        body text,
        archived boolean NOT NULL DEFAULT false,
        seen_at timestamptz NOT NULL DEFAULT '2019-06-01T00:00:00Z'
      );
      CREATE TRIGGER set_notes_seen
        BEFORE UPDATE ON office_dallas.notes FOR EACH ROW EXECUTE FUNCTION bump_seen();
      INSERT INTO office_dallas.notes (body) VALUES (NULL), ('kept');
    `);

    await runPerOfficeTransactionalStep(asClient(), noteStep);

    const rows = await pg.query<{ archived: boolean; seen_at: Date }>(
      `SELECT archived, seen_at FROM office_dallas.notes ORDER BY id`
    );
    expect(rows.rows.map((r) => r.archived)).toEqual([true, false]);
    // The suspension applied to the notes trigger, not a hard-coded tasks one.
    expect(rows.rows[0]!.seen_at.toISOString()).toBe(new Date("2019-06-01T00:00:00Z").toISOString());
  });

  it("supports a step with no triggers to suspend at all", async () => {
    await pg.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.notes (id serial PRIMARY KEY, archived boolean NOT NULL DEFAULT false);
      INSERT INTO office_dallas.notes DEFAULT VALUES;
    `);

    const result = await runPerOfficeTransactionalStep(asClient(), {
      label: "no-trigger step",
      table: "notes",
      requiredColumn: "archived",
      buildStatements: (schema: string) => [`UPDATE ${schema}.notes SET archived = true`],
    });

    expect(result.officesProcessed).toBe(1);
    const rows = await pg.query<{ archived: boolean }>(`SELECT archived FROM office_dallas.notes`);
    expect(rows.rows[0]?.archived).toBe(true);
  });

  it("validates the schema name before it reaches a statement", async () => {
    await expect(
      runPerOfficeTransactionalStep(
        {
          query: vi.fn(async (sql: string) => {
            if (sql.includes("information_schema.schemata")) {
              return { rows: [{ schema_name: 'office_x"; DROP TABLE widgets; --' }] };
            }
            return { rows: [{ n: 1 }] };
          }),
        } as never,
        widgetStep
      )
    ).rejects.toThrow(/Invalid office schema name/);
  });
});
