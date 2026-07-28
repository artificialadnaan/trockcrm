import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { fieldScorecards, scorecardCorrectiveActions } from "@trock-crm/shared/schema";
import {
  CORRECTIVE_ACTION_CARD_AWAITING_APPROVAL,
  CORRECTIVE_ACTION_CARD_CLOSED,
  CORRECTIVE_ACTION_CARD_OPEN,
  CORRECTIVE_ACTION_OUTSTANDING_STATUSES,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { recordCorrectiveActionEvent } from "./corrective-action-events.js";
import { restartCorrectiveActionCyclesForCards } from "./corrective-actions-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * The APPROVAL half of the corrective-action lifecycle.
 *
 * A super/PM submission no longer closes anything — it moves the item to `submitted` and the card to
 * `corrective_action_submitted`. From there an approver either accepts the work (item -> `approved`; the card
 * closes once every item is approved) or sends it back (item -> `rejected` with a required reason; the card
 * returns to `corrective_action_open`).
 *
 * Only the REJECTED items reopen. An approved item keeps its verdict, so a responder redoes one thing rather
 * than everything — which is the point of approving per item at all.
 */

export interface ApprovalActor {
  userId: string;
  name: string | null;
  email: string | null;
}

export interface ApprovalOutcome {
  /** Items whose status this call actually changed. Empty on a fully idempotent replay. */
  changedItemIds: string[];
  /** The card status after the call. */
  cardStatus: string;
  /** True when this call was the one that closed the card — the caller fires the "approved" notice once. */
  closed: boolean;
  /** True when this call returned the card to the responders — the caller fires the rejection notice. */
  reopened: boolean;
}

/**
 * A STRICTLY INCREASING scorecard generation token. `field_scorecards.updated_at` is the PDF artifact's
 * staleness token and the render single-flight key, and a bare `new Date()` can collide within a millisecond
 * of the write before it — leaving a render of the pre-approval state stamped as current, permanently.
 * Same expression the resolve path and evidence invalidation use.
 */
function nextGeneration() {
  return sql`GREATEST(${fieldScorecards.updatedAt} + interval '1 millisecond', NOW())`;
}

/**
 * Lock the card and read the item states under that lock.
 *
 * Every approval mutation serializes on the parent scorecard row, exactly as the responder resolve does.
 * Without it two approvers finishing the last two items could each read "one still outstanding" and neither
 * would close the card, leaving it stuck awaiting an approval that already happened.
 */
async function lockAndReadItems(tx: TenantDb, scorecardId: string) {
  await tx
    .select({ id: fieldScorecards.id })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, scorecardId))
    .limit(1)
    .for("update");

  return tx
    .select({ id: scorecardCorrectiveActions.id, status: scorecardCorrectiveActions.status })
    .from(scorecardCorrectiveActions)
    .where(eq(scorecardCorrectiveActions.scorecardId, scorecardId));
}

/**
 * Recompute the card status from the item set and write it if it changed.
 *
 * The three states are derived, never set directly by a caller:
 *   - anything OUTSTANDING (open or rejected) -> corrective_action_open
 *   - nothing outstanding, something awaiting approval -> corrective_action_submitted
 *   - every item approved -> corrective_action_closed
 *
 * `rejected` counting as outstanding is what stops a card closing with work the approver sent back.
 */
async function recomputeCardStatus(
  tx: TenantDb,
  scorecardId: string,
  items: Array<{ status: string }>,
  currentStatus: string,
): Promise<{ cardStatus: string; changed: boolean }> {
  const outstanding = items.filter((item) =>
    (CORRECTIVE_ACTION_OUTSTANDING_STATUSES as readonly string[]).includes(item.status),
  ).length;
  const awaiting = items.filter((item) => item.status === "submitted").length;

  const cardStatus =
    outstanding > 0
      ? CORRECTIVE_ACTION_CARD_OPEN
      : awaiting > 0
        ? CORRECTIVE_ACTION_CARD_AWAITING_APPROVAL
        : CORRECTIVE_ACTION_CARD_CLOSED;

  // ALWAYS write, even when the card's own status does not move.
  //
  // updated_at is the PDF's content generation and the currency check is an equality against it, so any item
  // change is content change. Approving 1 of 3 items leaves the card in corrective_action_submitted; an early
  // return here leaves the stale artifact comparing equal, classified as current, and the download omits the
  // approval — the reported bug, re-created one layer in. Same for rejecting one item of a card that already
  // had another open.
  //
  // `changed` still reports whether the STATUS moved, which is what the notification callers switch on.
  await tx
    .update(fieldScorecards)
    .set({ status: cardStatus, updatedAt: nextGeneration() })
    .where(eq(fieldScorecards.id, scorecardId));
  return { cardStatus, changed: cardStatus !== currentStatus };
}

async function readCardStatus(tx: TenantDb, scorecardId: string): Promise<string> {
  const [card] = await tx
    .select({ status: fieldScorecards.status })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, scorecardId))
    .limit(1);
  if (!card) throw new AppError(404, "Scorecard not found");
  return card.status;
}

/**
 * Approve one or more items. `itemIds` omitted approves every item currently awaiting approval (approve-all).
 *
 * Status-guarded: only a `submitted` item transitions, so a double-click is an idempotent no-op rather than a
 * duplicate event, and an item the responder has meanwhile resubmitted is never approved out from under them.
 */
export async function approveCorrectiveActionItems(
  tx: TenantDb,
  input: { scorecardId: string; itemIds?: string[]; actor: ApprovalActor },
): Promise<ApprovalOutcome> {
  const items = await lockAndReadItems(tx, input.scorecardId);
  if (items.length === 0) throw new AppError(404, "This scorecard has no corrective actions.");
  const currentStatus = await readCardStatus(tx, input.scorecardId);

  const targetIds = input.itemIds?.length
    ? input.itemIds
    : items.filter((item) => item.status === "submitted").map((item) => item.id);

  // Explicit ids must belong to this scorecard — never approve across cards.
  if (input.itemIds?.length) {
    const known = new Set(items.map((item) => item.id));
    const stray = input.itemIds.filter((id) => !known.has(id));
    if (stray.length > 0) throw new AppError(404, "Corrective-action item not found on this scorecard.");
  }

  const changedItemIds: string[] = [];
  for (const itemId of targetIds) {
    const updated = await tx
      .update(scorecardCorrectiveActions)
      .set({ status: "approved", updatedAt: new Date() })
      .where(
        and(
          eq(scorecardCorrectiveActions.id, itemId),
          eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
          // Only an item awaiting approval transitions.
          eq(scorecardCorrectiveActions.status, "submitted"),
        ),
      )
      .returning({ id: scorecardCorrectiveActions.id });
    if (updated.length === 0) continue;

    changedItemIds.push(itemId);
    await recordCorrectiveActionEvent(tx, {
      correctiveActionId: itemId,
      scorecardId: input.scorecardId,
      eventType: "approved",
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      actorEmail: input.actor.email,
      comment: null,
    });
  }

  const after = items.map((item) =>
    changedItemIds.includes(item.id) ? { ...item, status: "approved" } : item,
  );
  const { cardStatus } = await recomputeCardStatus(tx, input.scorecardId, after, currentStatus);

  return {
    changedItemIds,
    cardStatus,
    // Only the call that actually moved the card reports `closed`, so the completion notice fires once.
    closed: cardStatus === CORRECTIVE_ACTION_CARD_CLOSED && currentStatus !== CORRECTIVE_ACTION_CARD_CLOSED,
    reopened: false,
  };
}

/**
 * Reject one item with a required reason, returning it to the responders.
 *
 * ONLY this item reopens — approved siblings keep their verdict. The comment is mandatory: telling the
 * responder what to fix is the entire content of a rejection, and an empty one would send them an email that
 * says nothing.
 */
export async function rejectCorrectiveActionItem(
  tx: TenantDb,
  input: { scorecardId: string; itemId: string; comment: string; actor: ApprovalActor },
): Promise<ApprovalOutcome> {
  const comment = input.comment?.trim();
  if (!comment) {
    throw new AppError(400, "A rejection needs a comment explaining what still has to be fixed.");
  }

  const items = await lockAndReadItems(tx, input.scorecardId);
  const target = items.find((item) => item.id === input.itemId);
  if (!target) throw new AppError(404, "Corrective-action item not found on this scorecard.");
  const currentStatus = await readCardStatus(tx, input.scorecardId);

  const updated = await tx
    .update(scorecardCorrectiveActions)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(scorecardCorrectiveActions.id, input.itemId),
        eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
        eq(scorecardCorrectiveActions.status, "submitted"),
      ),
    )
    .returning({ id: scorecardCorrectiveActions.id });

  if (updated.length === 0) {
    // Already rejected, already approved, or resubmitted since the approver loaded the page. Idempotent
    // no-op rather than an error: the approver's intent is already reflected or superseded.
    return { changedItemIds: [], cardStatus: currentStatus, closed: false, reopened: false };
  }

  await recordCorrectiveActionEvent(tx, {
    correctiveActionId: input.itemId,
    scorecardId: input.scorecardId,
    eventType: "rejected",
    actorUserId: input.actor.userId,
    actorName: input.actor.name,
    actorEmail: input.actor.email,
    comment,
  });

  const after = items.map((item) =>
    item.id === input.itemId ? { ...item, status: "rejected" } : item,
  );
  const { cardStatus } = await recomputeCardStatus(tx, input.scorecardId, after, currentStatus);

  return {
    changedItemIds: [input.itemId],
    cardStatus,
    closed: false,
    // The card left the approver's queue and went back to the responders — the caller notifies them, and
    // MUST restart their notification cycle, since their response tokens were revoked when they submitted.
    reopened:
      cardStatus === CORRECTIVE_ACTION_CARD_OPEN && currentStatus !== CORRECTIVE_ACTION_CARD_OPEN,
  };
}

/** Ids of the items on a card currently awaiting approval — drives the approve-all affordance. */
export async function getItemsAwaitingApproval(db: TenantDb, scorecardId: string): Promise<string[]> {
  const rows = await db
    .select({ id: scorecardCorrectiveActions.id })
    .from(scorecardCorrectiveActions)
    .where(
      and(
        eq(scorecardCorrectiveActions.scorecardId, scorecardId),
        eq(scorecardCorrectiveActions.status, "submitted"),
      ),
    );
  return rows.map((row) => row.id);
}

/** Kept for the routes layer's bulk id validation. */
export async function itemsBelongToScorecard(
  db: TenantDb,
  scorecardId: string,
  itemIds: string[],
): Promise<boolean> {
  if (itemIds.length === 0) return true;
  const rows = await db
    .select({ id: scorecardCorrectiveActions.id })
    .from(scorecardCorrectiveActions)
    .where(
      and(
        eq(scorecardCorrectiveActions.scorecardId, scorecardId),
        inArray(scorecardCorrectiveActions.id, itemIds),
      ),
    );
  return rows.length === itemIds.length;
}

/**
 * Reject an item AND restart the responders' notification cycle, in one transaction.
 *
 * These belong together and must not be two calls a route can get half-right. The responders' tokens were
 * DELETED when they submitted, so a rejection on its own leaves them holding no valid link: they receive a
 * notice, click it, get a 403, and the card stalls with work nobody can do.
 *
 * The restart machinery is REUSED rather than reimplemented. It mints a fresh cycle nonce, clears the send
 * stamp, deletes stale tokens and enqueues the responder job — and it carries the supersession and delivery
 * guarantees thirteen review rounds put into it. A second token path would have to re-earn all of that, and
 * would be the second place a cycle can be started wrongly.
 */
export async function rejectAndRestart(
  tx: TenantDb,
  input: {
    office: { id: string; slug: string };
    scorecardId: string;
    itemId: string;
    comment: string;
    actor: ApprovalActor;
  },
): Promise<ApprovalOutcome> {
  const outcome = await rejectCorrectiveActionItem(tx, {
    scorecardId: input.scorecardId,
    itemId: input.itemId,
    comment: input.comment,
    actor: input.actor,
  });

  // Only on a REAL transition back to the responders. A no-op rejection (already rejected, or resubmitted
  // since the approver loaded the page), or one on a card that was already open, must not churn the cycle —
  // that would revoke a link the responder may be using right now and re-notify them about no change.
  if (!outcome.reopened) return outcome;

  const [card] = await tx
    .select({ dealId: fieldScorecards.dealId })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, input.scorecardId))
    .limit(1);
  if (!card) return outcome;

  await restartCorrectiveActionCyclesForCards(
    tx,
    [{ id: input.scorecardId, dealId: card.dealId }],
    input.office,
  );
  return outcome;
}
