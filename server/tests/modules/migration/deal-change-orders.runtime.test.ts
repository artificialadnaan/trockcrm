import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Runs the REAL migration SQL against PGlite and asserts the table's behavior (CHECK, FK cascade,
// indexes, idempotency). The migration's static block targets office_dallas; the DO-loop targets
// every office_* schema — both create the table here, exercising both paths idempotently.
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0153_deal_change_orders.sql", import.meta.url),
  "utf8",
);

const SCHEMA = "office_dallas";
const USER = "00000000-0000-0000-0000-000000000099";
const DEAL = "00000000-0000-0000-0000-000000000001";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY);
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    INSERT INTO public.users (id) VALUES ('${USER}');
    INSERT INTO ${SCHEMA}.deals (id) VALUES ('${DEAL}');
  `);
  await db.exec(MIGRATION_SQL);
  return db;
}

describe("migration 0153 — deal_change_orders (runtime, PGlite)", () => {
  it("creates the table and accepts a positive-amount change order", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.deal_change_orders (deal_id, signed_date, amount, description, created_by)
       VALUES ($1, '2026-03-15', 1500.00, 'extra flashing', $2)`,
      [DEAL, USER],
    );
    const rows = await pg.query<{ amount: string; signed_date: string }>(
      `SELECT amount, signed_date FROM ${SCHEMA}.deal_change_orders WHERE deal_id = $1`,
      [DEAL],
    );
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0]!.amount)).toBe(1500);
  });

  it("rejects a zero or negative amount via the CHECK constraint", async () => {
    pg = await setup();
    await expect(
      pg.query(
        `INSERT INTO ${SCHEMA}.deal_change_orders (deal_id, signed_date, amount) VALUES ($1, '2026-03-15', 0)`,
        [DEAL],
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO ${SCHEMA}.deal_change_orders (deal_id, signed_date, amount) VALUES ($1, '2026-03-15', -10)`,
        [DEAL],
      ),
    ).rejects.toThrow();
    const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.deal_change_orders`);
    expect(rows.rows).toHaveLength(0);
  });

  it("cascade-deletes change orders when the parent deal is deleted", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.deal_change_orders (deal_id, signed_date, amount) VALUES ($1, '2026-03-15', 500)`,
      [DEAL],
    );
    await pg.query(`DELETE FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL]);
    const rows = await pg.query(
      `SELECT 1 FROM ${SCHEMA}.deal_change_orders WHERE deal_id = $1`,
      [DEAL],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("creates the deal_id and signed_date indexes", async () => {
    pg = await setup();
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND tablename = 'deal_change_orders'`,
    );
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toContain("deal_change_orders_deal_id_idx");
    expect(names).toContain("deal_change_orders_signed_date_idx");
  });

  it("is idempotent — re-running the migration does not error", async () => {
    pg = await setup();
    await pg.exec(MIGRATION_SQL);
    const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.deal_change_orders`);
    expect(rows.rows).toHaveLength(0);
  });

  it("applies to EVERY office_* schema via the DO-loop, not just office_dallas", async () => {
    pg = await setup();
    // A second tenant provisioned before the migration runs again.
    await pg.exec(`
      CREATE SCHEMA office_atlanta;
      CREATE TABLE office_atlanta.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    const deal2 = "00000000-0000-0000-0000-000000000002";
    await pg.query(`INSERT INTO office_atlanta.deals (id) VALUES ($1)`, [deal2]);
    await pg.exec(MIGRATION_SQL); // DO-loop now sees office_atlanta too

    await pg.query(
      `INSERT INTO office_atlanta.deal_change_orders (deal_id, signed_date, amount) VALUES ($1, '2026-03-15', 250)`,
      [deal2],
    );
    const rows = await pg.query(`SELECT amount FROM office_atlanta.deal_change_orders WHERE deal_id = $1`, [deal2]);
    expect(rows.rows).toHaveLength(1);
    // CHECK still enforced in the looped schema.
    await expect(
      pg.query(`INSERT INTO office_atlanta.deal_change_orders (deal_id, signed_date, amount) VALUES ($1, '2026-03-15', 0)`, [deal2]),
    ).rejects.toThrow();
  });
});
