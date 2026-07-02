import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Runs the REAL migration 0155 against PGlite and asserts: the two new columns, the project_number
// unique-index exemption for is_change_order rows, the self-FK cascade, idempotency, and the DO-loop
// across every office_* schema. The migration ALTERs an existing deals table that already carries the
// pre-0155 (non-exempted) project_number unique index, so the DROP/recreate path is exercised.
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0156_deal_change_order_child_columns.sql", import.meta.url),
  "utf8"
);

const SCHEMA = "office_dallas";
const PARENT = "00000000-0000-0000-0000-000000000001";
const CHILD = "00000000-0000-0000-0000-000000000002";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_source_user_id uuid, project_number text);
    CREATE UNIQUE INDEX deals_project_number_uidx ON ${SCHEMA}.deals (project_number) WHERE project_number IS NOT NULL;
    INSERT INTO ${SCHEMA}.deals (id, project_number) VALUES ('${PARENT}', 'DFW-1');
  `);
  await db.exec(MIGRATION_SQL);
  return db;
}

describe("migration 0156 — CO child-deal columns + project_number exemption (runtime, PGlite)", () => {
  it("adds is_change_order (default false) and parent_deal_id", async () => {
    pg = await setup();
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='${SCHEMA}' AND table_name='deals' AND column_name IN ('is_change_order','parent_deal_id')`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["is_change_order", "parent_deal_id"]);
    const r = await pg.query<{ is_change_order: boolean }>(
      `SELECT is_change_order FROM ${SCHEMA}.deals WHERE id='${PARENT}'`
    );
    expect(r.rows[0]!.is_change_order).toBe(false); // existing rows default to false
  });

  it("exempts is_change_order rows from the project_number unique index", async () => {
    pg = await setup();
    // Two CO children sharing the parent's project_number → allowed (exempted).
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals (id, project_number, is_change_order, parent_deal_id) VALUES ('${CHILD}', 'DFW-1', true, '${PARENT}')`
    );
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals (project_number, is_change_order, parent_deal_id) VALUES ('DFW-1', true, '${PARENT}')`
    );
    const n = await pg.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM ${SCHEMA}.deals WHERE project_number='DFW-1' AND is_change_order=true`
    );
    expect(Number(n.rows[0]!.c)).toBe(2);
    // A second NON-CO deal with the same project_number still violates the unique index.
    await expect(
      pg.query(`INSERT INTO ${SCHEMA}.deals (project_number, is_change_order) VALUES ('DFW-1', false)`)
    ).rejects.toThrow();
  });

  it("cascade-deletes CO children when the parent deal is deleted (self-FK)", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals (id, project_number, is_change_order, parent_deal_id) VALUES ('${CHILD}', 'DFW-1', true, '${PARENT}')`
    );
    await pg.query(`DELETE FROM ${SCHEMA}.deals WHERE id='${PARENT}'`);
    const r = await pg.query(`SELECT 1 FROM ${SCHEMA}.deals WHERE id='${CHILD}'`);
    expect(r.rows).toHaveLength(0);
  });

  it("is idempotent — re-running the migration does not error", async () => {
    pg = await setup();
    await pg.exec(MIGRATION_SQL);
    const cols = await pg.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND table_name='deals' AND column_name='is_change_order'`
    );
    expect(cols.rows).toHaveLength(1);
  });

  it("applies to EVERY office_* schema via the DO-loop, not just office_dallas", async () => {
    pg = await setup();
    await pg.exec(`
      CREATE SCHEMA office_atlanta;
      CREATE TABLE office_atlanta.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_number text);
      CREATE UNIQUE INDEX deals_project_number_uidx ON office_atlanta.deals (project_number) WHERE project_number IS NOT NULL;
      INSERT INTO office_atlanta.deals (id, project_number) VALUES ('${PARENT}', 'ATL-1');
    `);
    await pg.exec(MIGRATION_SQL); // DO-loop now sees office_atlanta too
    // Exemption holds in the looped schema: a CO child shares the number; a non-CO dup conflicts.
    await pg.query(
      `INSERT INTO office_atlanta.deals (project_number, is_change_order, parent_deal_id) VALUES ('ATL-1', true, '${PARENT}')`
    );
    const n = await pg.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM office_atlanta.deals WHERE project_number='ATL-1'`);
    expect(Number(n.rows[0]!.c)).toBe(2);
    await expect(
      pg.query(`INSERT INTO office_atlanta.deals (project_number, is_change_order) VALUES ('ATL-1', false)`)
    ).rejects.toThrow();
  });
});
