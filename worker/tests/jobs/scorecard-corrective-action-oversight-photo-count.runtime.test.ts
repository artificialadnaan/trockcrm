import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { correctiveActionItemsSql } from "../../src/jobs/scorecard-corrective-action-oversight-email.js";

// The awaiting-approval email's item read, run on a REAL engine.
//
// Everything else in this suite mocks `query` by matching substrings, which proves a query mentions the right
// tables and nothing about what it returns. This one carries a number the approver uses to decide whether the
// evidence supports the fix, so it gets executed. It imports the handler's own SQL — re-typing it here would
// test the copy in this file.
const CARD = "11111111-1111-1111-1111-111111111111";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.scorecard_corrective_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scorecard_id uuid, item_type text, item_ref text, item_label text, status text,
      responder_name text, responder_email text, responded_at timestamptz, response_comment text);
    CREATE TABLE office_dallas.scorecard_corrective_action_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq bigserial, corrective_action_id uuid,
      event_type text, actor_name text, actor_email text, created_at timestamptz DEFAULT now());
    CREATE TABLE office_dallas.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_active boolean, deleted_at timestamptz);
    CREATE TABLE office_dallas.field_scorecard_photos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_id uuid,
      corrective_action_id uuid, corrective_action_event_id uuid);
  `);
});

afterAll(async () => {
  await db.close();
});

async function seedItem(label: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO office_dallas.scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
     VALUES ($1, 'action_item', '0', $2, 'submitted') RETURNING id`,
    [CARD, label],
  );
  return rows[0].id;
}

async function addEvent(itemId: string, eventType: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO office_dallas.scorecard_corrective_action_events (corrective_action_id, event_type)
     VALUES ($1, $2) RETURNING id`,
    [itemId, eventType],
  );
  return rows[0].id;
}

async function addPhoto(itemId: string, eventId: string | null, opts: { deleted?: boolean } = {}) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO office_dallas.files (is_active, deleted_at) VALUES (true, $1) RETURNING id`,
    [opts.deleted ? new Date() : null],
  );
  await db.query(
    `INSERT INTO office_dallas.field_scorecard_photos (file_id, corrective_action_id, corrective_action_event_id)
     VALUES ($1, $2, $3)`,
    [rows[0].id, itemId, eventId],
  );
}

async function photoCounts(): Promise<Map<string, number>> {
  const { rows } = await db.query<{ item_label: string; photo_count: number | string }>(
    correctiveActionItemsSql("office_dallas"),
    [CARD],
  );
  return new Map(rows.map((r) => [r.item_label, Number(r.photo_count)]));
}

describe("awaiting-approval item read: photo_count", () => {
  it("counts THIS attempt's photos, not every photo the item ever collected", async () => {
    // response_comment, responder and responded_at all describe the LATEST submission. An item-wide count
    // put that comment beside three photos from a rejected attempt plus the one rework photo — "4 photos"
    // attached to a one-photo response. The approver is judging whether the evidence supports the fix, so
    // the inflated number argues for approval.
    const item = await seedItem("Rework");
    const first = await addEvent(item, "submitted");
    await addEvent(item, "rejected");
    const latest = await addEvent(item, "submitted");
    for (let i = 0; i < 3; i += 1) await addPhoto(item, first);
    await addPhoto(item, latest);
    // ...and a soft-deleted photo on the CURRENT attempt still does not count, as before.
    await addPhoto(item, latest, { deleted: true });

    expect((await photoCounts()).get("Rework")).toBe(1);
  });

  it("falls back to the item-wide set when there is no thread", async () => {
    // A pre-0202 card, or photos predating the event backfill: the item-wide set IS the attempt's set, and
    // scoping to a latest submission that does not exist would report every such response as photo-less.
    const item = await seedItem("Legacy");
    await addPhoto(item, null);
    await addPhoto(item, null);

    expect((await photoCounts()).get("Legacy")).toBe(2);
  });
});
