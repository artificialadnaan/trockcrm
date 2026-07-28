import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Runs the REAL migration 0201 against PGlite. Beyond adding the three oversight columns it must GRANDFATHER
// corrective actions that were already open at deploy time — see the test bodies for why that matters.
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0201_field_scorecards_corrective_action_oversight_stamps.sql", import.meta.url),
  "utf8",
);

const SCHEMA = "office_dallas";
const OPEN_CARD = "00000000-0000-0000-0000-000000000001";
const CLOSED_CARD = "00000000-0000-0000-0000-000000000002";
const ON_STANDARD_CARD = "00000000-0000-0000-0000-000000000003";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.field_scorecards (
      id uuid PRIMARY KEY,
      status varchar(30)
    );
    INSERT INTO ${SCHEMA}.field_scorecards (id, status) VALUES
      ('${OPEN_CARD}', 'corrective_action_open'),
      ('${CLOSED_CARD}', 'corrective_action_closed'),
      ('${ON_STANDARD_CARD}', 'submitted');
  `);
  await db.exec(MIGRATION_SQL);
  return db;
}

async function openedStamp(db: PGlite, id: string): Promise<Date | null> {
  const rows = await db.query<{ corrective_action_oversight_opened_at: Date | null }>(
    `SELECT corrective_action_oversight_opened_at FROM ${SCHEMA}.field_scorecards WHERE id = $1`,
    [id],
  );
  return rows.rows[0]?.corrective_action_oversight_opened_at ?? null;
}

describe("migration 0201 — corrective-action oversight stamps (runtime, PGlite)", () => {
  it("adds the three oversight columns", async () => {
    pg = await setup();
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = '${SCHEMA}' AND table_name = 'field_scorecards'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "corrective_action_oversight_opened_at",
        "corrective_action_oversight_closed_at",
        "corrective_action_oversight_cycle",
      ]),
    );
  });

  it("GRANDFATHERS a card that was already corrective_action_open", async () => {
    // The opened-notice enqueue fires only on the TRANSITION into corrective_action_open. A card already in
    // that state never makes that transition under the new code, so it would never get an opened notice —
    // but it WOULD get a "Corrective Action Completed" email when it closes, since the closed enqueue has no
    // such precondition. Oversight receiving a completion for a cycle it was never told about reads as a bug
    // in the notifications rather than a rollout artifact.
    pg = await setup();
    expect(await openedStamp(pg, OPEN_CARD)).toBeInstanceOf(Date);
  });

  it("leaves every other card unstamped, so real notices are not suppressed", async () => {
    // Only in-flight cycles are grandfathered. A closed card has no pending notice to suppress, and stamping
    // a card that has not tripped the band would silently swallow its FIRST genuine opened notice.
    pg = await setup();
    expect(await openedStamp(pg, CLOSED_CARD)).toBeNull();
    expect(await openedStamp(pg, ON_STANDARD_CARD)).toBeNull();
  });

  it("is idempotent — a rerun does not re-stamp or move an existing stamp", async () => {
    pg = await setup();
    const first = await openedStamp(pg, OPEN_CARD);
    await pg.exec(MIGRATION_SQL);
    expect(await openedStamp(pg, OPEN_CARD)).toEqual(first);
  });

  it("runs across EVERY office_* schema, not just the template", async () => {
    // The tenant DO-loop is the half that reaches production offices; the TENANT_SCHEMA block only seeds new
    // ones. A migration that updated office_dallas alone would grandfather nothing in a real deployment.
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA ${SCHEMA};
      CREATE SCHEMA office_atlanta;
      CREATE TABLE ${SCHEMA}.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
      CREATE TABLE office_atlanta.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
      INSERT INTO office_atlanta.field_scorecards (id, status)
        VALUES ('${OPEN_CARD}', 'corrective_action_open');
    `);
    await db.exec(MIGRATION_SQL);

    const rows = await db.query<{ corrective_action_oversight_opened_at: Date | null }>(
      `SELECT corrective_action_oversight_opened_at FROM office_atlanta.field_scorecards WHERE id = $1`,
      [OPEN_CARD],
    );
    expect(rows.rows[0]?.corrective_action_oversight_opened_at).toBeInstanceOf(Date);
  });

  it("skips a schema with no field_scorecards table instead of erroring", async () => {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE SCHEMA ${SCHEMA};
      CREATE SCHEMA office_empty;
      CREATE TABLE ${SCHEMA}.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    `);
    await expect(db.exec(MIGRATION_SQL)).resolves.toBeDefined();
  });
});
