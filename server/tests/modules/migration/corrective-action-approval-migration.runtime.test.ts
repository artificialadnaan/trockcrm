import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Runs the REAL migration 0202 against PGlite. The DDL is straightforward; what needs pinning is the DATA
// rename, which has to respect what already happened to each card.
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0202_corrective_action_approval.sql", import.meta.url),
  "utf8",
);

const SCHEMA = "office_dallas";
const CLOSED_CARD = "00000000-0000-0000-0000-00000000000c";
const OPEN_CARD = "00000000-0000-0000-0000-00000000000o".replace("o", "1");

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.field_scorecards (id uuid PRIMARY KEY, status varchar(30));
    CREATE TABLE ${SCHEMA}.scorecard_corrective_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scorecard_id uuid NOT NULL REFERENCES ${SCHEMA}.field_scorecards(id),
      item_type text, item_ref text, item_label text,
      status text NOT NULL,
      -- The migration's event backfill reads these, so the fixture has to carry them.
      response_comment text, responded_by_user_id uuid, responder_name text, responder_email text,
      responded_at timestamptz, updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.field_scorecard_photos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      corrective_action_id uuid
    );
    CREATE INDEX scorecard_corrective_actions_open_idx
      ON ${SCHEMA}.scorecard_corrective_actions (scorecard_id) WHERE status = 'open';

    INSERT INTO ${SCHEMA}.field_scorecards (id, status) VALUES
      ('${CLOSED_CARD}', 'corrective_action_closed'),
      ('${OPEN_CARD}', 'corrective_action_open');

    -- A finished card: under the OLD model, answering closed it immediately.
    INSERT INTO ${SCHEMA}.scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
      VALUES ('${CLOSED_CARD}', 'action_item', '0', 'Historic fix', 'resolved');
    -- A card still in flight: one answered item, one never answered.
    INSERT INTO ${SCHEMA}.scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
      VALUES ('${OPEN_CARD}', 'action_item', '0', 'Answered', 'resolved'),
             ('${OPEN_CARD}', 'action_item', '1', 'Never answered', 'open');
  `);
  await db.exec(MIGRATION_SQL);
  return db;
}

async function statuses(db: PGlite, cardId: string): Promise<string[]> {
  const rows = await db.query<{ status: string }>(
    `SELECT status FROM ${SCHEMA}.scorecard_corrective_actions WHERE scorecard_id = $1 ORDER BY item_ref`,
    [cardId],
  );
  return rows.rows.map((r) => r.status);
}

describe("migration 0202 — corrective-action approval (runtime, PGlite)", () => {
  it("REGRESSION: an already-CLOSED card's items become approved, not submitted", async () => {
    // Under the old model an answered item closed the card immediately, so every item on a card that is
    // already corrective_action_closed was in effect accepted — nobody is going to review it now.
    //
    // A blanket rename to `submitted` puts every historically closed card back into the approver's queue:
    // the card status is DERIVED from its items, so the next time anything touches the card it recomputes to
    // corrective_action_submitted and finished work resurfaces as pending review.
    pg = await setup();
    expect(await statuses(pg, CLOSED_CARD)).toEqual(["approved"]);
  });

  it("an in-flight card's answered item becomes submitted — it genuinely awaits review", async () => {
    pg = await setup();
    expect(await statuses(pg, OPEN_CARD)).toEqual(["submitted", "open"]);
  });

  it("widens the outstanding index to include rejected, and drops the narrower one", async () => {
    // The index backs the closure check. Left at `open` alone, a card could close with rejected work in it.
    pg = await setup();
    const rows = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1`,
      [SCHEMA],
    );
    const names = rows.rows.map((r) => r.indexname);
    expect(names).toContain("scorecard_corrective_actions_outstanding_idx");
    expect(names).not.toContain("scorecard_corrective_actions_open_idx");
    const outstanding = rows.rows.find(
      (r) => r.indexname === "scorecard_corrective_actions_outstanding_idx",
    );
    expect(outstanding?.indexdef).toMatch(/rejected/);
  });

  it("is idempotent — a rerun leaves the migrated statuses alone", async () => {
    pg = await setup();
    await pg.exec(MIGRATION_SQL);
    expect(await statuses(pg, CLOSED_CARD)).toEqual(["approved"]);
    expect(await statuses(pg, OPEN_CARD)).toEqual(["submitted", "open"]);
  });

  it("REGRESSION: an event SURVIVES its item being removed by an edit", async () => {
    // The table is the append-only record of what happened. ON DELETE CASCADE would erase the approver's
    // rejection and the responder's answer when an edit drops the flagged item — exactly the history the PDF
    // and the CRM exist to show. SET NULL detaches it instead, and scorecard_id (denormalized for this
    // reason) keeps it readable as part of the card's record.
    pg = await setup();
    const [item] = (
      await pg.query<{ id: string }>(
        `SELECT id FROM ${SCHEMA}.scorecard_corrective_actions WHERE scorecard_id = $1`,
        [CLOSED_CARD],
      )
    ).rows;

    await pg.query(
      `INSERT INTO ${SCHEMA}.scorecard_corrective_action_events
         (corrective_action_id, scorecard_id, event_type, actor_name, comment)
       VALUES ($1, $2, 'rejected', 'James Helms', 'Send it back.')`,
      [item.id, CLOSED_CARD],
    );

    await pg.query(`DELETE FROM ${SCHEMA}.scorecard_corrective_actions WHERE id = $1`, [item.id]);

    const rows = await pg.query<{ corrective_action_id: string | null; comment: string; scorecard_id: string }>(
      `SELECT corrective_action_id, comment, scorecard_id
         FROM ${SCHEMA}.scorecard_corrective_action_events WHERE event_type = 'rejected'`,
    );
    // Still there, detached, and still attributable to its card.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].corrective_action_id).toBeNull();
    expect(rows.rows[0].comment).toBe("Send it back.");
    expect(rows.rows[0].scorecard_id).toBe(CLOSED_CARD);
  });
});
