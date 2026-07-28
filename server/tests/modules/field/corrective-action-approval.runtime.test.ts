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
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  approveCorrectiveActionItems,
  rejectCorrectiveActionItem,
} from "../../../src/modules/field/corrective-action-approval.js";
import { getCorrectiveActionEventsByItem } from "../../../src/modules/field/corrective-action-events.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const CARD = "22222222-2222-2222-2222-222222222222";
const APPROVER = { userId: USER, name: "James Helms", email: "james@trockgc.com" };

let pg: PGlite;
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, project_number text, is_active boolean DEFAULT true);
    CREATE TABLE files (id uuid PRIMARY KEY, description text, is_active boolean DEFAULT true, deleted_at timestamptz);
  `);
  await pg.exec(
    tenantSchemaSql("public", [
      fieldScorecards,
      fieldScorecardItems,
      fieldScorecardPhotos,
      scorecardCorrectiveActions,
      scorecardCorrectiveActionEvents,
    ]),
  );
  await pg.exec(`INSERT INTO deals (id, name) VALUES ('${DEAL}', 'Maple St');`);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_events`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
});

/** A below-band card whose items are all already `submitted` — i.e. sitting in the approver's queue. */
async function seedAwaitingApproval(itemCount: number, cardStatus = "corrective_action_submitted") {
  await tdb.insert(fieldScorecards).values({
    id: CARD,
    clientSubmissionId: "66666666-6666-6666-6666-000000000001",
    dealId: DEAL,
    weekOf: "2026-07-27",
    totalScore: 23,
    formVersion: 2,
    rating: "corrective_action",
    status: cardStatus,
    submittedBy: USER,
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
      })
      .returning({ id: scorecardCorrectiveActions.id });
    ids.push(row.id);
  }
  return ids;
}

async function cardStatus(): Promise<string> {
  const res = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${CARD}`);
  return (res.rows[0] as { status: string }).status;
}
async function itemStatuses(): Promise<string[]> {
  const res = await tdb.execute(
    sql`SELECT status FROM scorecard_corrective_actions WHERE scorecard_id = ${CARD} ORDER BY item_ref`,
  );
  return (res.rows as { status: string }[]).map((r) => r.status);
}

describe("approving corrective-action items", () => {
  it("closes the card only when EVERY item is approved", async () => {
    const ids = await seedAwaitingApproval(2);

    await tdb.transaction(async (tx: any) => {
      const out = await approveCorrectiveActionItems(tx, { scorecardId: CARD, itemIds: [ids[0]], actor: APPROVER });
      expect(out.closed).toBe(false);
    });
    expect(await cardStatus()).toBe("corrective_action_submitted");

    await tdb.transaction(async (tx: any) => {
      const out = await approveCorrectiveActionItems(tx, { scorecardId: CARD, itemIds: [ids[1]], actor: APPROVER });
      expect(out.closed).toBe(true);
    });
    expect(await cardStatus()).toBe("corrective_action_closed");
    expect(await itemStatuses()).toEqual(["approved", "approved"]);
  });

  it("approve-all clears the whole queue in one call", async () => {
    await seedAwaitingApproval(3);
    await tdb.transaction(async (tx: any) => {
      const out = await approveCorrectiveActionItems(tx, { scorecardId: CARD, actor: APPROVER });
      expect(out.changedItemIds).toHaveLength(3);
      expect(out.closed).toBe(true);
    });
    expect(await cardStatus()).toBe("corrective_action_closed");
  });

  it("is idempotent — a double approve changes nothing and records one event", async () => {
    const ids = await seedAwaitingApproval(1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await tdb.transaction(async (tx: any) => {
        await approveCorrectiveActionItems(tx, { scorecardId: CARD, itemIds: ids, actor: APPROVER });
      });
    }
    const events = await getCorrectiveActionEventsByItem(tdb, CARD);
    expect(events.get(ids[0])?.filter((e) => e.eventType === "approved")).toHaveLength(1);
  });

  it("reports closed only ONCE, so the completion notice cannot double-fire", async () => {
    const ids = await seedAwaitingApproval(1);
    const outcomes: boolean[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await tdb.transaction(async (tx: any) => {
        const out = await approveCorrectiveActionItems(tx, { scorecardId: CARD, itemIds: ids, actor: APPROVER });
        outcomes.push(out.closed);
      });
    }
    expect(outcomes).toEqual([true, false]);
  });

  it("refuses to approve an item belonging to another scorecard", async () => {
    await seedAwaitingApproval(1);
    await expect(
      tdb.transaction(async (tx: any) =>
        approveCorrectiveActionItems(tx, {
          scorecardId: CARD,
          itemIds: ["44444444-4444-4444-4444-444444444444"],
          actor: APPROVER,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does NOT approve an item the responder has resubmitted (status-guarded)", async () => {
    const ids = await seedAwaitingApproval(2);
    // One item bounced back to the responder and is open again.
    await tdb.execute(sql`UPDATE scorecard_corrective_actions SET status = 'open' WHERE id = ${ids[1]}`);

    await tdb.transaction(async (tx: any) => {
      const out = await approveCorrectiveActionItems(tx, { scorecardId: CARD, actor: APPROVER });
      expect(out.changedItemIds).toEqual([ids[0]]);
    });
    expect(await itemStatuses()).toEqual(["approved", "open"]);
    // Outstanding work exists, so the card is back with the responders — NOT closed.
    expect(await cardStatus()).toBe("corrective_action_open");
  });
});

describe("rejecting a corrective-action item", () => {
  it("reopens ONLY the rejected item and returns the card to the responders", async () => {
    const ids = await seedAwaitingApproval(3);
    await tdb.transaction(async (tx: any) => {
      await approveCorrectiveActionItems(tx, { scorecardId: CARD, itemIds: [ids[0]], actor: APPROVER });
    });

    await tdb.transaction(async (tx: any) => {
      const out = await rejectCorrectiveActionItem(tx, {
        scorecardId: CARD,
        itemId: ids[1],
        comment: "The guardrail photo shows the wrong elevation.",
        actor: APPROVER,
      });
      expect(out.reopened).toBe(true);
    });

    // Approved work is NOT thrown away — that is the point of per-item approval.
    expect(await itemStatuses()).toEqual(["approved", "rejected", "submitted"]);
    expect(await cardStatus()).toBe("corrective_action_open");
  });

  it("requires a comment — an empty rejection tells the responder nothing", async () => {
    const ids = await seedAwaitingApproval(1);
    for (const comment of ["", "   "]) {
      await expect(
        tdb.transaction(async (tx: any) =>
          rejectCorrectiveActionItem(tx, { scorecardId: CARD, itemId: ids[0], comment, actor: APPROVER }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await itemStatuses()).toEqual(["submitted"]);
  });

  it("records the reason on the thread", async () => {
    const ids = await seedAwaitingApproval(1);
    await tdb.transaction(async (tx: any) => {
      await rejectCorrectiveActionItem(tx, {
        scorecardId: CARD,
        itemId: ids[0],
        comment: "Re-torque and photograph all four anchors.",
        actor: APPROVER,
      });
    });
    const events = await getCorrectiveActionEventsByItem(tdb, CARD);
    const rejection = events.get(ids[0])!.find((e) => e.eventType === "rejected")!;
    expect(rejection.comment).toBe("Re-torque and photograph all four anchors.");
    expect(rejection.actorName).toBe("James Helms");
    expect(rejection.actorEmail).toBe("james@trockgc.com");
  });

  it("a rejected item keeps the card open even when every OTHER item is approved", async () => {
    // The highest-risk predicate in this change: `rejected` must count as outstanding. If it did not, this
    // card would close with work the approver explicitly sent back.
    const ids = await seedAwaitingApproval(2);
    await tdb.transaction(async (tx: any) => {
      await rejectCorrectiveActionItem(tx, {
        scorecardId: CARD,
        itemId: ids[0],
        comment: "Not fixed.",
        actor: APPROVER,
      });
    });
    await tdb.transaction(async (tx: any) => {
      const out = await approveCorrectiveActionItems(tx, { scorecardId: CARD, itemIds: [ids[1]], actor: APPROVER });
      expect(out.closed).toBe(false);
    });

    expect(await itemStatuses()).toEqual(["rejected", "approved"]);
    expect(await cardStatus()).toBe("corrective_action_open");
  });

  it("is an idempotent no-op on an already-rejected item", async () => {
    const ids = await seedAwaitingApproval(1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await tdb.transaction(async (tx: any) => {
        await rejectCorrectiveActionItem(tx, {
          scorecardId: CARD,
          itemId: ids[0],
          comment: "Still not fixed.",
          actor: APPROVER,
        });
      });
    }
    const events = await getCorrectiveActionEventsByItem(tdb, CARD);
    expect(events.get(ids[0])?.filter((e) => e.eventType === "rejected")).toHaveLength(1);
  });
});

describe("the event thread", () => {
  it("records the full back-and-forth in order, preserving every attempt", async () => {
    // submit -> reject -> resubmit -> approve. The whole point of the events table: the item row holds only
    // the CURRENT state, so without this the first attempt's comment would be overwritten by the second.
    const ids = await seedAwaitingApproval(1);
    const itemId = ids[0];

    await tdb.transaction(async (tx: any) => {
      await rejectCorrectiveActionItem(tx, {
        scorecardId: CARD,
        itemId,
        comment: "First rejection.",
        actor: APPROVER,
      });
    });
    // The responder resubmits (modelled directly; the responder path writes its own `submitted` event).
    await tdb.execute(sql`UPDATE scorecard_corrective_actions SET status = 'submitted' WHERE id = ${itemId}`);
    await tdb.insert(scorecardCorrectiveActionEvents).values({
      correctiveActionId: itemId,
      scorecardId: CARD,
      eventType: "submitted",
      actorName: "Sam Super",
      comment: "Re-torqued and re-photographed.",
    });
    await tdb.transaction(async (tx: any) => {
      await approveCorrectiveActionItems(tx, { scorecardId: CARD, itemIds: [itemId], actor: APPROVER });
    });

    const thread = (await getCorrectiveActionEventsByItem(tdb, CARD)).get(itemId)!;
    expect(thread.map((e) => e.eventType)).toEqual(["rejected", "submitted", "approved"]);
    // The FIRST rejection's reason survives the resubmission that followed it.
    expect(thread[0].comment).toBe("First rejection.");
    expect(thread[1].comment).toBe("Re-torqued and re-photographed.");
    expect(await cardStatus()).toBe("corrective_action_closed");
  });

  it("REGRESSION: advances the card generation even when the CARD status does not move", async () => {
    // updated_at IS the PDF's content generation, and the currency check is an equality against it.
    // Approving one item of three changes what the PDF renders (the thread gains an `approved` event) while
    // leaving the card in corrective_action_submitted — so an early return here leaves the stale artifact
    // comparing equal and classified as current, and the download omits the approval. That is exactly the
    // bug this whole line of work exists to fix, re-created one layer in.
    const ids = await seedAwaitingApproval(3);
    const before = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${CARD}`);
    const priorGeneration = new Date((before.rows[0] as { updated_at: string }).updated_at);

    await approveCorrectiveActionItems(tdb, {
      scorecardId: CARD,
      itemIds: [ids[0]],
      actor: APPROVER,
    });

    // The card has NOT moved — two items still await approval...
    expect(await cardStatus()).toBe("corrective_action_submitted");
    // ...but its generation has, so the next download re-renders and carries the approval.
    const after = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${CARD}`);
    const newGeneration = new Date((after.rows[0] as { updated_at: string }).updated_at);
    expect(newGeneration.getTime()).toBeGreaterThan(priorGeneration.getTime());
  });

  it("advances the generation on a rejection that leaves the card open", async () => {
    // Same hazard on the other verb: rejecting one item of a card that already had another item open leaves
    // the card in corrective_action_open, so the status does not move and the rejection reason would never
    // reach the PDF.
    const ids = await seedAwaitingApproval(2, "corrective_action_open");
    await tdb.execute(
      sql`UPDATE scorecard_corrective_actions SET status = 'open' WHERE id = ${ids[1]}`,
    );
    const before = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${CARD}`);
    const priorGeneration = new Date((before.rows[0] as { updated_at: string }).updated_at);

    await rejectCorrectiveActionItem(tdb, {
      scorecardId: CARD,
      itemId: ids[0],
      comment: "Torque values were not documented.",
      actor: APPROVER,
    });

    expect(await cardStatus()).toBe("corrective_action_open");
    const after = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${CARD}`);
    expect(new Date((after.rows[0] as { updated_at: string }).updated_at).getTime()).toBeGreaterThan(
      priorGeneration.getTime(),
    );
  });
});
