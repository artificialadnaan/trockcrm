import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0246 applied VERBATIM from disk, not modelled.
 *
 * The column exists so an automatic dismissal can be told from a person's, immutably — getFollowUpCompliance
 * scores every dismissal as a rep's missed follow-up otherwise, and two paths dismiss with nobody involved.
 *
 * The case that matters most here is the SKIP: production carries `office_pwauditoffice`, a
 * partially-provisioned schema with no usable tasks table. A migration file is ONE statement in ONE
 * transaction, so a loop that raises on that schema takes every other office down with it — which is
 * exactly how a deploy would fail on the one office nobody uses.
 */
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0246_tasks_auto_dismissed_reason.sql", import.meta.url),
  "utf8",
);

let pg: PGlite | null = null;
afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function columnsNamed(db: PGlite, schema: string) {
  const { rows } = await db.query<{ data_type: string; character_maximum_length: number | null }>(
    `SELECT data_type, character_maximum_length FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'auto_dismissed_reason'`,
    [schema]
  );
  return rows;
}

describe("migration 0246 — tasks.auto_dismissed_reason", () => {
  it("adds the column to every provisioned office and skips a partial schema without aborting", async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE SCHEMA office_dallas;
      CREATE SCHEMA office_atlanta;
      CREATE SCHEMA office_pwauditoffice;  -- partially provisioned: NO tasks table, as on production
      CREATE TABLE office_dallas.tasks (id uuid PRIMARY KEY, status text NOT NULL);
      CREATE TABLE office_atlanta.tasks (id uuid PRIMARY KEY, status text NOT NULL);
    `);

    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();

    expect(await columnsNamed(pg, "office_dallas")).toEqual([
      { data_type: "character varying", character_maximum_length: 120 },
    ]);
    expect(await columnsNamed(pg, "office_atlanta")).toEqual([
      { data_type: "character varying", character_maximum_length: 120 },
    ]);
    // The partial schema is untouched and, crucially, did not take the other two down with it.
    expect(await columnsNamed(pg, "office_pwauditoffice")).toEqual([]);
  });

  it("is idempotent — a second run changes nothing and raises nothing", async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.tasks (id uuid PRIMARY KEY, status text NOT NULL);
    `);
    await pg.exec(MIGRATION_SQL);
    await pg.exec(`UPDATE office_dallas.tasks SET status = status`);
    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();
    expect(await columnsNamed(pg, "office_dallas")).toHaveLength(1);
  });

  it("leaves existing rows NULL — a historical dismissal is not retroactively blamed on the system", async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.tasks (id uuid PRIMARY KEY, status text NOT NULL);
      INSERT INTO office_dallas.tasks (id, status)
        VALUES ('00000000-0000-4000-8000-000000000001', 'dismissed');
    `);
    await pg.exec(MIGRATION_SQL);
    const { rows } = await pg.query<{ auto_dismissed_reason: string | null }>(
      `SELECT auto_dismissed_reason FROM office_dallas.tasks`
    );
    // NULL is the conservative reading and what every pre-existing row means: a person closed this, or it
    // is still open. Guessing otherwise would silently rewrite past compliance in the other direction.
    expect(rows[0].auto_dismissed_reason).toBeNull();
  });

  it("carries a TENANT_SCHEMA block so a newly provisioned office gets the column too", () => {
    // The office provisioner clones the marked block, rewriting office_dallas to the new schema. Without
    // it a new office silently lacks the column and its sweeps stop being distinguishable.
    expect(MIGRATION_SQL).toContain("-- TENANT_SCHEMA_START");
    expect(MIGRATION_SQL).toContain("-- TENANT_SCHEMA_END");
    const block = MIGRATION_SQL.split("-- TENANT_SCHEMA_START")[1].split("-- TENANT_SCHEMA_END")[0];
    expect(block).toContain("office_dallas.tasks");
    expect(block).toContain("auto_dismissed_reason");
  });
});
