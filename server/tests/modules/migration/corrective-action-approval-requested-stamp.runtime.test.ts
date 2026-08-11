import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Runs the REAL migration 0203 against PGlite. The column itself is trivial; what needs pinning is that the
// tenant DO-loop reaches every office (the half that touches production) and that existing rows are left
// UNSTAMPED, which is the opposite of 0201's grandfathering and deliberately so.
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0203_corrective_action_approval_requested_stamp.sql", import.meta.url),
  "utf8",
);

const COLUMN = "corrective_action_approval_requested_at";
const AWAITING_CARD = "00000000-0000-0000-0000-000000000001";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function columns(db: PGlite, schema: string): Promise<string[]> {
  const rows = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'field_scorecards'`,
    [schema],
  );
  return rows.rows.map((r) => r.column_name);
}

describe("migration 0203 — approval-requested stamp (runtime, PGlite)", () => {
  it("adds the column to EVERY office schema, not just the template", async () => {
    // The DO-loop is the half that reaches production offices; the TENANT_SCHEMA block only seeds new ones.
    // A migration that updated office_dallas alone would leave every real office without the column, and the
    // worker's stamp UPDATE would then fail at runtime rather than at deploy.
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE SCHEMA office_atlanta;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
      CREATE TABLE office_atlanta.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    `);
    await db.exec(MIGRATION_SQL);

    expect(await columns(db, "office_dallas")).toContain(COLUMN);
    expect(await columns(db, "office_atlanta")).toContain(COLUMN);
  });

  it("leaves the stamp NULL, so a card already awaiting approval still gets its first notice", async () => {
    // Deliberately the opposite of 0201's grandfathering. There, the opened phase had already passed
    // unobserved and a retro notice would have announced week-old work as new. Here the approver has real
    // work sitting in their queue that nobody has told them about — suppressing it would strand the card
    // silently, which is the failure this feature exists to prevent.
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
      INSERT INTO office_dallas.field_scorecards (id, status)
        VALUES ('${AWAITING_CARD}', 'corrective_action_submitted');
    `);
    await db.exec(MIGRATION_SQL);

    const rows = await db.query<Record<string, Date | null>>(
      `SELECT ${COLUMN} FROM office_dallas.field_scorecards WHERE id = $1`,
      [AWAITING_CARD],
    );
    expect(rows.rows[0]?.[COLUMN]).toBeNull();
  });

  it("is idempotent", async () => {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    `);
    await db.exec(MIGRATION_SQL);
    await expect(db.exec(MIGRATION_SQL)).resolves.toBeDefined();
  });

  it("skips a schema with no field_scorecards table instead of erroring", async () => {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA office_dallas;
      CREATE SCHEMA office_empty;
      CREATE TABLE office_dallas.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    `);
    await expect(db.exec(MIGRATION_SQL)).resolves.toBeDefined();
  });
});
