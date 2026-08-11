import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  fieldScorecards,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionEvents,
} from "@trock-crm/shared/schema";
import {
  CORRECTIVE_ACTION_CARD_AWAITING_APPROVAL,
  CORRECTIVE_ACTION_CARD_CLOSED,
  CORRECTIVE_ACTION_CARD_OPEN,
  CORRECTIVE_ACTION_OUTSTANDING_STATUSES,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { recordCorrectiveActionEvent } from "./corrective-action-events.js";
import {
  enqueueCorrectiveActionOversightClosed,
  restartCorrectiveActionCyclesForCards,
} from "./corrective-actions-service.js";

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

/**
 * The submission the approver was LOOKING AT, per item.
 *
 * Item ids alone bind the approval to the right items but not to the right ATTEMPT: with two approvers, one
 * can load submission A, the other reject it, the responder submit B — and the first approver's click then
 * approves B, which they never saw. The item id and status are identical across both. Carrying the
 * submission event id makes the approval refer to a specific piece of work rather than to a slot.
 */
export type ReviewedAttempts = Record<string, string>;

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
  /**
   * The card's generation AFTER this call.
   *
   * Returned so a reviewer acting on several items from one page load can carry it into the next verdict
   * without waiting for a refetch — every verdict advances the generation, so without this the second click
   * would 409 against the generation its own first click created.
   */
  generation: string | null;
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
/**
 * Refuse the approval verbs on a card whose corrective action is FINISHED.
 *
 * Deliberately narrow: it rejects `corrective_action_closed` only. A card sitting at
 * `corrective_action_open` is a legitimate target — a sibling item may still be unanswered while another
 * awaits the approver, and rejecting that second item is real work the responders must hear about. Gating on
 * "must be awaiting approval" would break exactly that case.
 *
 * The closed case is the one that matters: migration 0202 makes an already-closed card's items `approved`,
 * so they no longer match the item-level `submitted` guard, but leaving the item status as the ONLY defence
 * means one stray request could reopen a corrective action closed months ago and email its responders.
 */
function assertCardNotFinished(cardStatus: string): void {
  if (cardStatus === CORRECTIVE_ACTION_CARD_CLOSED) {
    throw new AppError(
      409,
      "This corrective action is already approved and closed.",
      "CORRECTIVE_ACTION_ALREADY_CLOSED",
    );
  }
}

async function lockAndReadItems(tx: TenantDb, scorecardId: string) {
  await tx
    .select({ id: fieldScorecards.id })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, scorecardId))
    .limit(1)
    .for("update");

  return tx
    .select({
      id: scorecardCorrectiveActions.id,
      status: scorecardCorrectiveActions.status,
      // Carried so each event can snapshot the item it was about — a detached event with no identity is
      // unreadable, and this read is already the locked source of truth.
      itemType: scorecardCorrectiveActions.itemType,
      itemRef: scorecardCorrectiveActions.itemRef,
      itemLabel: scorecardCorrectiveActions.itemLabel,
    })
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
  itemsChanged: boolean,
): Promise<{ cardStatus: string; changed: boolean; generation: Date | null }> {
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

  // Nothing changed at ALL — a duplicate approve, or approve-all with nothing left awaiting. Writing here
  // would advance the generation and invalidate a perfectly current PDF, forcing a pointless re-render on
  // every double-click of an operation documented as idempotent.
  if (!itemsChanged && cardStatus === currentStatus) return { cardStatus, changed: false, generation: null };

  // Otherwise ALWAYS write, even when the card's own status does not move.
  //
  // updated_at is the PDF's content generation and the currency check is an equality against it, so any item
  // change is content change. Approving 1 of 3 items leaves the card in corrective_action_submitted; an early
  // return here leaves the stale artifact comparing equal, classified as current, and the download omits the
  // approval — the reported bug, re-created one layer in. Same for rejecting one item of a card that already
  // had another open.
  //
  // `changed` still reports whether the STATUS moved, which is what the notification callers switch on.
  const [written] = await tx
    .update(fieldScorecards)
    .set({ status: cardStatus, updatedAt: nextGeneration() })
    .where(eq(fieldScorecards.id, scorecardId))
    .returning({ generation: fieldScorecards.updatedAt });
  return { cardStatus, changed: cardStatus !== currentStatus, generation: written?.generation ?? null };
}

async function readCardStatus(tx: TenantDb, scorecardId: string): Promise<string> {
  return (await readCard(tx, scorecardId)).status;
}

async function readCard(
  tx: TenantDb,
  scorecardId: string,
): Promise<{ status: string; generation: Date | null }> {
  const [card] = await tx
    .select({ status: fieldScorecards.status, generation: fieldScorecards.updatedAt })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, scorecardId))
    .limit(1);
  if (!card) throw new AppError(404, "Scorecard not found");
  return { status: card.status, generation: card.generation ?? null };
}

/**
 * Refuse a verdict filed against a version of the scorecard that has since changed.
 *
 * The attempt guard binds a verdict to the corrective-action RESPONSE the reviewer read. It cannot see the
 * rest of the card: a scorecard stays editable while it awaits approval (deliberately — approval has no
 * timeout, so locking it there would strand the card), and the submitter can change scores, notes, signatures
 * or the ORIGINAL evidence without touching a single corrective-action event. The reviewed submission ids are
 * then still latest, the stale click passes, and the approval is recorded over content nobody reviewed.
 *
 * `updated_at` is the card's content generation — the same token the PDF currency check uses — so comparing
 * it catches every such edit. Absent from older clients, which keep the previous behaviour.
 */
async function assertReviewedGenerationIsCurrent(
  tx: TenantDb,
  scorecardId: string,
  reviewedGeneration: string | undefined,
  current: Date | null,
): Promise<void> {
  if (!reviewedGeneration || !current) return;
  if (new Date(reviewedGeneration).getTime() === current.getTime()) return;
  throw new AppError(
    409,
    "This scorecard changed after you opened it. Refresh to review the current version.",
    "CORRECTIVE_ACTION_CARD_SUPERSEDED",
  );
}

/**
 * Approve one or more items. `itemIds` omitted approves every item currently awaiting approval (approve-all).
 *
 * Status-guarded: only a `submitted` item transitions, so a double-click is an idempotent no-op rather than a
 * duplicate event, and an item the responder has meanwhile resubmitted is never approved out from under them.
 */
export async function approveCorrectiveActionItems(
  tx: TenantDb,
  input: {
    scorecardId: string;
    itemIds?: string[];
    actor: ApprovalActor;
    /** itemId → the submission event id the approver reviewed. Omitted by older clients. */
    reviewedAttempts?: ReviewedAttempts;
    /** The card generation on screen, so an edit made since cannot be approved unseen. */
    reviewedGeneration?: string;
  },
): Promise<ApprovalOutcome> {
  const items = await lockAndReadItems(tx, input.scorecardId);
  if (items.length === 0) throw new AppError(404, "This scorecard has no corrective actions.");
  const card = await readCard(tx, input.scorecardId);
  const currentStatus = card.status;
  await assertReviewedGenerationIsCurrent(tx, input.scorecardId, input.reviewedGeneration, card.generation);

  const targetIds = input.itemIds?.length
    ? input.itemIds
    : items.filter((item) => item.status === "submitted").map((item) => item.id);

  // Explicit ids must belong to this scorecard — never approve across cards.
  if (input.itemIds?.length) {
    const known = new Set(items.map((item) => item.id));
    const stray = input.itemIds.filter((id) => !known.has(id));
    if (stray.length > 0) throw new AppError(404, "Corrective-action item not found on this scorecard.");
  }

  await assertReviewedAttemptsAreLatest(tx, targetIds, input.reviewedAttempts);

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
      // Snapshot identity so the event survives its item being removed by a later edit.
      itemType: items.find((i) => i.id === itemId)?.itemType ?? null,
      itemRef: items.find((i) => i.id === itemId)?.itemRef ?? null,
      itemLabel: items.find((i) => i.id === itemId)?.itemLabel ?? null,
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      actorEmail: input.actor.email,
      comment: null,
    });
  }

  const after = items.map((item) =>
    changedItemIds.includes(item.id) ? { ...item, status: "approved" } : item,
  );
  const { cardStatus, generation } = await recomputeCardStatus(
    tx,
    input.scorecardId,
    after,
    currentStatus,
    changedItemIds.length > 0,
  );

  return {
    changedItemIds,
    cardStatus,
    // Only the call that actually moved the card reports `closed`, so the completion notice fires once.
    closed: cardStatus === CORRECTIVE_ACTION_CARD_CLOSED && currentStatus !== CORRECTIVE_ACTION_CARD_CLOSED,
    reopened: false,
    generation: (generation ?? card.generation)?.toISOString() ?? null,
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
  input: {
    scorecardId: string;
    itemId: string;
    comment: string;
    actor: ApprovalActor;
    /** The submission event the rejecter reviewed. Omitted by older clients. */
    reviewedAttempt?: string;
    /** The card generation on screen, so an edit made since cannot be rejected unseen either. */
    reviewedGeneration?: string;
  },
): Promise<ApprovalOutcome> {
  const comment = input.comment?.trim();
  if (!comment) {
    throw new AppError(400, "A rejection needs a comment explaining what still has to be fixed.");
  }

  const items = await lockAndReadItems(tx, input.scorecardId);
  const target = items.find((item) => item.id === input.itemId);
  if (!target) throw new AppError(404, "Corrective-action item not found on this scorecard.");
  const card = await readCard(tx, input.scorecardId);
  const currentStatus = card.status;
  assertCardNotFinished(currentStatus);
  await assertReviewedGenerationIsCurrent(tx, input.scorecardId, input.reviewedGeneration, card.generation);
  await assertReviewedAttemptsAreLatest(
    tx,
    [input.itemId],
    input.reviewedAttempt ? { [input.itemId]: input.reviewedAttempt } : undefined,
  );

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
    return {
      changedItemIds: [],
      cardStatus: currentStatus,
      closed: false,
      reopened: false,
      generation: card.generation?.toISOString() ?? null,
    };
  }

  await recordCorrectiveActionEvent(tx, {
    correctiveActionId: input.itemId,
    scorecardId: input.scorecardId,
    eventType: "rejected",
    itemType: target.itemType ?? null,
    itemRef: target.itemRef ?? null,
    itemLabel: target.itemLabel ?? null,
    actorUserId: input.actor.userId,
    actorName: input.actor.name,
    actorEmail: input.actor.email,
    comment,
  });

  const after = items.map((item) =>
    item.id === input.itemId ? { ...item, status: "rejected" } : item,
  );
  const { cardStatus, generation } = await recomputeCardStatus(
    tx,
    input.scorecardId,
    after,
    currentStatus,
    true,
  );

  return {
    changedItemIds: [input.itemId],
    cardStatus,
    closed: false,
    // The card left the approver's queue and went back to the responders — the caller notifies them, and
    // MUST restart their notification cycle, since their response tokens were revoked when they submitted.
    reopened:
      cardStatus === CORRECTIVE_ACTION_CARD_OPEN && currentStatus !== CORRECTIVE_ACTION_CARD_OPEN,
    generation: (generation ?? card.generation)?.toISOString() ?? null,
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
    reviewedAttempt?: string;
    reviewedGeneration?: string;
  },
): Promise<ApprovalOutcome> {
  const outcome = await rejectCorrectiveActionItem(tx, {
    scorecardId: input.scorecardId,
    itemId: input.itemId,
    comment: input.comment,
    actor: input.actor,
    reviewedAttempt: input.reviewedAttempt,
    reviewedGeneration: input.reviewedGeneration,
  });

  // Restart whenever an item ACTUALLY moved to `rejected` — not only when the CARD transitioned back to
  // open. If a sibling was already open the card never transitions, but the approver has still returned real
  // work with a new comment, and gating on the card transition means the responders are never told about it.
  //
  // This does revoke a link they may hold from the previous cycle. That is the right trade: the replacement
  // email lists EVERY outstanding item with its reason, so they get a strictly more complete picture
  // immediately. Silence about a returned item is the worse failure.
  //
  // A genuine no-op (already rejected, or resubmitted since the approver loaded the page) changes nothing and
  // is filtered here, so a double-clicked Reject cannot churn the cycle.
  if (outcome.changedItemIds.length === 0) return outcome;

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

/**
 * Approve items AND tell oversight when that closed the card, in one transaction.
 *
 * The counterpart to rejectAndRestart, and it exists for the same reason: approveCorrectiveActionItems
 * reports `closed` but cannot act on it, and a route that forgets to is silent — the card closes, the
 * approver sees success, and oversight is simply never told. That is the same failure shape as an enqueued
 * job nobody handles: nothing errors, so nothing surfaces it.
 *
 * Enqueued on the TRANSITION, not the request, so a double-clicked Approve announces one closure.
 */
export async function approveAndNotify(
  tx: TenantDb,
  input: {
    office: { id: string; slug: string };
    scorecardId: string;
    itemIds?: string[];
    actor: ApprovalActor;
    reviewedAttempts?: ReviewedAttempts;
    reviewedGeneration?: string;
  },
): Promise<ApprovalOutcome> {
  const outcome = await approveCorrectiveActionItems(tx, {
    scorecardId: input.scorecardId,
    itemIds: input.itemIds,
    actor: input.actor,
    reviewedAttempts: input.reviewedAttempts,
    reviewedGeneration: input.reviewedGeneration,
  });
  if (outcome.closed) {
    await enqueueCorrectiveActionOversightClosed(tx, {
      office: input.office,
      scorecardId: input.scorecardId,
    });
  }
  return outcome;
}

/**
 * Refuse any target whose latest submission is NOT the one the reviewer had on screen.
 *
 * Item ids bind a verdict to the right ITEMS but not the right ATTEMPT: one approver can load submission A,
 * another reject it, the responder submit B — and the first approver's click then lands on B, which they never
 * saw. The id and the status are identical across both, so only the submission event distinguishes them. That
 * is true of REJECT exactly as it is of approve — a stale reject records an outdated reason against unseen
 * work and restarts the responder's cycle for a fault they may already have fixed — so both verbs go through
 * here rather than one carrying the check and the other being remembered later.
 *
 * Skipped entirely when the client sends nothing, so an older build keeps working rather than failing every
 * verdict.
 */
async function assertReviewedAttemptsAreLatest(
  tx: TenantDb,
  targetIds: string[],
  reviewedAttempts: ReviewedAttempts | undefined,
): Promise<void> {
  if (!reviewedAttempts || Object.keys(reviewedAttempts).length === 0) return;
  const latestByItem = await latestSubmissionByItem(tx, targetIds);
  for (const itemId of targetIds) {
    const reviewed = reviewedAttempts[itemId];
    const latest = latestByItem.get(itemId);
    if (reviewed && latest && latest !== reviewed) {
      throw new AppError(
        409,
        "This item was answered again after you opened it. Refresh to review the new response.",
        "CORRECTIVE_ACTION_ATTEMPT_SUPERSEDED",
      );
    }
  }
}

/** The most recent `submitted` event per item — what a verdict must be pinned to. */
async function latestSubmissionByItem(
  tx: TenantDb,
  itemIds: string[],
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: scorecardCorrectiveActionEvents.id,
      correctiveActionId: scorecardCorrectiveActionEvents.correctiveActionId,
      seq: scorecardCorrectiveActionEvents.seq,
    })
    .from(scorecardCorrectiveActionEvents)
    .where(
      and(
        inArray(scorecardCorrectiveActionEvents.correctiveActionId, itemIds),
        eq(scorecardCorrectiveActionEvents.eventType, "submitted"),
      ),
    )
    .orderBy(asc(scorecardCorrectiveActionEvents.seq));

  // Ascending, so the last write per item wins — the latest attempt.
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (row.correctiveActionId) latest.set(row.correctiveActionId, row.id);
  }
  return latest;
}
