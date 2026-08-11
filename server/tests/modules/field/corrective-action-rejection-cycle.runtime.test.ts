import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionEvents,
  scorecardCorrectiveActionTokens,
  jobQueue,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  approveAndNotify,
  rejectAndRestart,
} from "../../../src/modules/field/corrective-action-approval.js";
import { getCorrectiveActionEventsByItem } from "../../../src/modules/field/corrective-action-events.js";

// A rejection sends the item back to the super/PM — but their response tokens were DELETED when they
// submitted. A rejection notice carrying no live token is an email the recipient cannot act on: they click,
// they get a 403, and the card stalls with work nobody can do. So rejecting and restarting their notification
// cycle are one operation, not two calls a route can get half-right.

const OFFICE = { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" };
const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const CARD = "22222222-2222-2222-2222-222222222222";
const APPROVER = { userId: USER, name: "James Helms", email: "james@trockgc.com" };

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, project_number text, is_active boolean DEFAULT true);
    CREATE TABLE files (id uuid PRIMARY KEY, description text, is_active boolean DEFAULT true, deleted_at timestamptz);
  `);
  await pg.exec(tenantSchemaSql("public", [jobQueue]));
  await pg.exec(
    tenantSchemaSql("public", [
      fieldScorecards,
      fieldScorecardItems,
      fieldScorecardPhotos,
      scorecardCorrectiveActions,
      scorecardCorrectiveActionEvents,
      scorecardCorrectiveActionTokens,
    ]),
  );
  await pg.exec(`INSERT INTO deals (id, name) VALUES ('${DEAL}', 'Maple St');`);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM job_queue`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_events`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
});

/** A card awaiting approval, with a stale token from the cycle the responders already answered. */
async function seedAwaitingApproval(itemCount = 1): Promise<string[]> {
  await tdb.insert(fieldScorecards).values({
    id: CARD,
    clientSubmissionId: "66666666-6666-6666-6666-000000000001",
    dealId: DEAL,
    weekOf: "2026-07-27",
    totalScore: 23,
    formVersion: 2,
    rating: "corrective_action",
    status: "corrective_action_submitted",
    submittedBy: USER,
    correctiveActionCycleNonce: "99999999-9999-9999-9999-999999999999",
    correctiveActionEmailSentAt: new Date("2026-07-27T12:00:00.000Z"),
  });
  const ids: string[] = [];
  for (let i = 0; i < itemCount; i += 1) {
    const [row] = await tdb
      .insert(scorecardCorrectiveActions)
      .values({
        scorecardId: CARD,
        itemType: "action_item",
        itemRef: String(i),
        itemLabel: `Item ${i}`,
        status: "submitted",
        responderName: "Pat Manager",
        responseComment: "Fixed.",
        respondedAt: new Date(),
      })
      .returning({ id: scorecardCorrectiveActions.id });
    ids.push(row.id);
  }
  await tdb.insert(scorecardCorrectiveActionTokens).values({
    scorecardId: CARD,
    recipientEmail: "pat@trockgc.com",
    role: "project_manager",
    tokenHash: "stale-hash-from-the-answered-cycle",
    expiresAt: new Date("2026-08-27T12:00:00.000Z"),
  });
  return ids;
}

async function cardState(): Promise<{ nonce: string | null; sentAt: unknown; status: string }> {
  const res = await tdb.execute(sql`
    SELECT corrective_action_cycle_nonce AS nonce, corrective_action_email_sent_at AS sent_at, status
      FROM field_scorecards WHERE id = ${CARD}
  `);
  const row = res.rows[0] as { nonce: string | null; sent_at: unknown; status: string };
  return { nonce: row.nonce, sentAt: row.sent_at, status: row.status };
}

async function tokenCount(): Promise<number> {
  const res = await tdb.execute(sql`SELECT count(*)::int AS n FROM scorecard_corrective_action_tokens`);
  return (res.rows[0] as { n: number }).n;
}

async function responderJobs(): Promise<number> {
  const res = await tdb.execute(sql`
    SELECT count(*)::int AS n FROM job_queue WHERE job_type = 'scorecard_corrective_action_email'
  `);
  return (res.rows[0] as { n: number }).n;
}

describe("rejectAndRestart", () => {
  it("REGRESSION: a rejection mints a fresh cycle and live tokens, so the emailed link works", async () => {
    const [itemId] = await seedAwaitingApproval();
    const before = await cardState();

    await rejectAndRestart(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemId,
      comment: "Torque values were not documented.",
      actor: APPROVER,
    });

    const after = await cardState();
    // Back with the responders.
    expect(after.status).toBe("corrective_action_open");
    // A NEW cycle, so an in-flight job from the answered cycle cannot stamp this one.
    expect(after.nonce).not.toBe(before.nonce);
    // The send stamp is cleared, or the worker would treat this cycle as already notified and skip.
    expect(after.sentAt).toBeNull();
    // Stale tokens are gone — nobody keeps a link bound to the cycle that has been superseded.
    expect(await tokenCount()).toBe(0);
    // And a responder job is queued, which is what mints the fresh ones.
    expect(await responderJobs()).toBe(1);
  });

  it("records the rejection on the thread, with its reason and who sent it back", async () => {
    const [itemId] = await seedAwaitingApproval();

    await rejectAndRestart(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemId,
      comment: "Torque values were not documented.",
      actor: APPROVER,
    });

    const res = await tdb.execute(sql`
      SELECT event_type, actor_name, comment FROM scorecard_corrective_action_events ORDER BY seq
    `);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      event_type: "rejected",
      actor_name: "James Helms",
      comment: "Torque values were not documented.",
    });
  });

  it("does NOT churn the cycle for a no-op rejection", async () => {
    // Rejecting an already-rejected item is idempotent by design. Restarting anyway would revoke a link the
    // responder may be in the middle of using, and re-send them an email about a state that did not change.
    const [itemId] = await seedAwaitingApproval();
    const args = {
      office: OFFICE,
      scorecardId: CARD,
      itemId,
      comment: "Not enough detail.",
      actor: APPROVER,
    };
    await rejectAndRestart(tdb, args);
    const afterFirst = await cardState();
    const jobsAfterFirst = await responderJobs();

    await rejectAndRestart(tdb, args);

    const afterSecond = await cardState();
    expect(afterSecond.nonce).toBe(afterFirst.nonce);
    expect(await responderJobs()).toBe(jobsAfterFirst);
  });

  it("REGRESSION: notifies when a SECOND item is rejected on an already-open card", async () => {
    // My first version of this test asserted the opposite — that an already-open card is "not a transition"
    // and must stay quiet. That was wrong: the card not moving says nothing about whether the APPROVER
    // returned real work. A sibling already open means the card never transitions, so gating on the card
    // transition left responders never told that a second item came back, with a new comment.
    //
    // The replacement email lists every outstanding item and its reason, so revoking their older link is a
    // strictly more complete picture delivered immediately. Silence about returned work is the worse failure.
    const ids = await seedAwaitingApproval(2);
    await tdb.execute(sql`UPDATE scorecard_corrective_actions SET status = 'open' WHERE id = ${ids[1]}`);
    await tdb.execute(sql`UPDATE field_scorecards SET status = 'corrective_action_open' WHERE id = ${CARD}`);
    const before = await cardState();

    await rejectAndRestart(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemId: ids[0],
      comment: "Needs the torque log.",
      actor: APPROVER,
    });

    expect((await cardState()).nonce).not.toBe(before.nonce);
    expect(await responderJobs()).toBe(1);
  });

  it("REGRESSION: a no-op approve does not advance the generation and invalidate the PDF", async () => {
    // Task 1 made the card write unconditional so an item change that leaves the card status alone still
    // advances the generation. "Nothing changed at all" is a third case: a duplicate approve, or approve-all
    // with nothing left awaiting, would otherwise invalidate a perfectly current PDF on every double-click of
    // an operation documented as idempotent.
    const [itemId] = await seedAwaitingApproval();
    await approveAndNotify(tdb, { office: OFFICE, scorecardId: CARD, itemIds: [itemId], actor: APPROVER });
    const afterFirst = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${CARD}`);
    const generation = new Date((afterFirst.rows[0] as { updated_at: string }).updated_at);

    // Re-approve: nothing is `submitted` any more, so nothing changes.
    const outcome = await approveAndNotify(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemIds: [itemId],
      actor: APPROVER,
    });

    expect(outcome.changedItemIds).toEqual([]);
    const afterSecond = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${CARD}`);
    expect(new Date((afterSecond.rows[0] as { updated_at: string }).updated_at).getTime()).toBe(
      generation.getTime(),
    );
  });

  it("REGRESSION: approving the LAST item enqueues the approved notice", async () => {
    // approveCorrectiveActionItems returns closed: true documented as "the caller fires the approved notice
    // once" — and the route never did. James would approve the final item, the card would close, and
    // oversight would never be told. Exactly the shape of the awaiting-approval bug: a notification wired at
    // one end only, silent because nothing errors.
    const [itemId] = await seedAwaitingApproval();

    const outcome = await approveAndNotify(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemIds: [itemId],
      actor: APPROVER,
    });

    expect(outcome.closed).toBe(true);
    expect((await cardState()).status).toBe("corrective_action_closed");
    const jobs = await tdb.execute(sql`
      SELECT payload FROM job_queue WHERE job_type = 'scorecard_corrective_action_oversight_email'
    `);
    const closedJobs = (jobs.rows as Array<{ payload: { phase: string } }>).filter(
      (r) => r.payload.phase === "closed",
    );
    expect(closedJobs).toHaveLength(1);
  });

  it("does NOT notify when the approval leaves items still awaiting", async () => {
    // Approving 1 of 2 does not close the card, so there is nothing to announce yet. Firing here would tell
    // oversight the corrective action was approved while half of it is still in the queue.
    const ids = await seedAwaitingApproval(2);

    const outcome = await approveAndNotify(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemIds: [ids[0]],
      actor: APPROVER,
    });

    expect(outcome.closed).toBe(false);
    expect((await cardState()).status).toBe("corrective_action_submitted");
    const jobs = await tdb.execute(sql`
      SELECT count(*)::int AS n FROM job_queue WHERE job_type = 'scorecard_corrective_action_oversight_email'
    `);
    expect((jobs.rows[0] as { n: number }).n).toBe(0);
  });

  it("notifies ONCE when a re-approve is a no-op", async () => {
    // A double-clicked Approve must not announce the same closure twice — the state machine reports closed
    // only on the transition, and the enqueue follows that, not the request.
    const [itemId] = await seedAwaitingApproval();
    const args = { office: OFFICE, scorecardId: CARD, itemIds: [itemId], actor: APPROVER };
    await approveAndNotify(tdb, args);
    await approveAndNotify(tdb, args);

    const jobs = await tdb.execute(sql`
      SELECT count(*)::int AS n FROM job_queue WHERE job_type = 'scorecard_corrective_action_oversight_email'
    `);
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
  });

});

describe("the whole loop, end to end", () => {
  it("submit → awaiting → reject → rework → approve → closed, with the right notice at each hop", async () => {
    // Every other test in this feature covers ONE hop. That is how the integration gaps survived review: the
    // approve route not notifying, the CRM thread being empty, the rejection email losing its reason — each
    // piece passed its own test while the chain between them was broken. This walks the chain.
    const [itemId] = await seedAwaitingApproval();

    // 1. The card is with the approver, and they were asked.
    expect((await cardState()).status).toBe("corrective_action_submitted");

    // 2. Rejected — back to the responders, with a fresh cycle so their link works.
    const rejected = await rejectAndRestart(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemId,
      comment: "Torque values were not documented.",
      actor: APPROVER,
    });
    expect(rejected.reopened).toBe(true);
    expect((await cardState()).status).toBe("corrective_action_open");
    expect(await tokenCount()).toBe(0);
    expect(await responderJobs()).toBe(1);

    // 3. The responder reworks it. `rejected` is outstanding, so the response is accepted.
    await tdb.execute(sql`
      UPDATE scorecard_corrective_actions
         SET status = 'submitted', response_comment = 'Re-torqued, values logged.'
       WHERE id = ${itemId}
    `);
    await tdb.execute(sql`
      UPDATE field_scorecards SET status = 'corrective_action_submitted' WHERE id = ${CARD}
    `);

    // 4. Approved — the card closes and oversight is told exactly once.
    const approved = await approveAndNotify(tdb, {
      office: OFFICE,
      scorecardId: CARD,
      itemIds: [itemId],
      actor: APPROVER,
    });
    expect(approved.closed).toBe(true);
    expect((await cardState()).status).toBe("corrective_action_closed");

    const closedJobs = await tdb.execute(sql`
      SELECT payload FROM job_queue WHERE job_type = 'scorecard_corrective_action_oversight_email'
    `);
    const closed = (closedJobs.rows as Array<{ payload: { phase: string } }>).filter(
      (r) => r.payload.phase === "closed",
    );
    expect(closed).toHaveLength(1);

    // 5. And the THREAD tells the whole story — which is the feature's actual promise.
    const events = (await getCorrectiveActionEventsByItem(tdb, CARD)).get(itemId) ?? [];
    expect(events.map((e) => e.eventType)).toEqual(["rejected", "approved"]);
    expect(events[0].comment).toBe("Torque values were not documented.");
    expect(events[0].actorName).toBe("James Helms");
    // Identity is snapshotted, so this survives the item being removed by a later edit.
    expect(events[0].itemLabel).toBe("Item 0");
  });
});
