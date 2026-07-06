import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Runs the REAL migration SQL against PGlite and asserts table behavior (existence, UNIQUE, FK
// cascade, provisioning, idempotency). The static block targets office_dallas; the DO-loop targets
// every office_* schema — both create the table here, exercising both paths idempotently. Mirrors
// server/tests/modules/migration/deal-change-orders.runtime.test.ts (the 0153 runtime test).
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0176_rfp_votes.sql", import.meta.url),
  "utf8",
);

const SCHEMA = "office_dallas";
const USER = "00000000-0000-0000-0000-000000000099";
const DEAL = "00000000-0000-0000-0000-000000000001";
const ROUND = "00000000-0000-0000-0000-0000000000aa";

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

describe("migration 0173 — rfp_votes (runtime, PGlite)", () => {
  it("creates rfp_votes in office_dallas and accepts an approve vote", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
       VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
      [DEAL, ROUND, USER],
    );
    const rows = await pg.query<{ decision: string }>(
      `SELECT decision FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`,
      [DEAL],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.decision).toBe("approve");
  });

  it("rejects a duplicate vote by the same voter in the same round (UNIQUE)", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
       VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
      [DEAL, ROUND, USER],
    );
    await expect(
      pg.query(
        `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
         VALUES ($1, $2, $3, 'sidney@trockgc.com', 'reject')`,
        [DEAL, ROUND, USER],
      ),
    ).rejects.toThrow();
    const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`, [DEAL]);
    expect(rows.rows).toHaveLength(1);
  });

  it("cascade-deletes votes when the parent deal is deleted", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
       VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
      [DEAL, ROUND, USER],
    );
    await pg.query(`DELETE FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL]);
    const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`, [DEAL]);
    expect(rows.rows).toHaveLength(0);
  });

  it("nulls voter_user_id when the user row is deleted (ON DELETE SET NULL)", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.rfp_votes (deal_id, round_event_id, voter_user_id, voter_email, decision)
       VALUES ($1, $2, $3, 'sidney@trockgc.com', 'approve')`,
      [DEAL, ROUND, USER],
    );
    await pg.query(`DELETE FROM public.users WHERE id = $1`, [USER]);
    const rows = await pg.query<{ voter_user_id: string | null }>(
      `SELECT voter_user_id FROM ${SCHEMA}.rfp_votes WHERE deal_id = $1`,
      [DEAL],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.voter_user_id).toBeNull();
  });

  it("provisions rfp_votes in a second office via the DO-loop", async () => {
    pg = await setup();
    await pg.exec(`
      CREATE SCHEMA office_atlanta;
      CREATE TABLE office_atlanta.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    const deal2 = "00000000-0000-0000-0000-000000000002";
    await pg.query(`INSERT INTO office_atlanta.deals (id) VALUES ($1)`, [deal2]);
    await pg.exec(MIGRATION_SQL); // DO-loop now sees office_atlanta too
    await pg.query(
      `INSERT INTO office_atlanta.rfp_votes (deal_id, round_event_id, voter_email, decision)
       VALUES ($1, $2, 'james@trockgc.com', 'reject')`,
      [deal2, ROUND],
    );
    const rows = await pg.query(`SELECT 1 FROM office_atlanta.rfp_votes WHERE deal_id = $1`, [deal2]);
    expect(rows.rows).toHaveLength(1);
  });

  it("is idempotent — re-running the migration does not error", async () => {
    pg = await setup();
    await pg.exec(MIGRATION_SQL);
    const rows = await pg.query(`SELECT 1 FROM ${SCHEMA}.rfp_votes`);
    expect(rows.rows).toHaveLength(0);
  });
});
