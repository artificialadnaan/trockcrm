import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { fieldScorecards, jobQueue, scorecardCorrectiveActions } from "@trock-crm/shared/schema";
import {
  enumerateFlaggedItems,
  isCorrectiveActionBand,
  type FlaggedItem,
  type ScorecardRating,
} from "@trock-crm/shared/types";

// Matches the alias the field scorecard services use (scorecards-service.ts): the per-office tenant db.
type TenantDb = NodePgDatabase<typeof schema>;

// job_type string for the below-band corrective-action notification — MUST match the worker's
// registerJobHandler(SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB, ...). Duplicated here (server can't import the
// worker package) and kept identical to the copy in scorecards-service.ts so the create + edit reconcile
// paths enqueue the same job type.
const SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB = "scorecard_corrective_action_email";
// Give the synchronous PDF render + R2 upload a head start over the worker's poll (mirrors the
// field_scorecard_email delay). run_after is a short while in the future so the email doesn't race the poll.
const SCORECARD_EMAIL_RUN_AFTER_SECONDS = 120;

export interface ResolveCorrectiveActionInput {
  scorecardId: string;
  itemId: string;
  responseComment: string;
  /** Who documented the corrective action: a CRM user (userId) or an email-only responder (name/email). */
  respondedBy: { userId: string | null; name: string | null; email: string | null };
  /** Response evidence file ids — linked by Plan 2's endpoint; accepted here so the signature is stable. */
  photoFileIds?: string[];
}

/**
 * Mark one corrective-action item resolved; if it was the last open item for the scorecard, auto-close the
 * scorecard (status -> corrective_action_closed). Either the superintendent or the PM can complete it — no
 * dual sign-off (spec §8).
 *
 * Idempotent: resolving an already-resolved (or unknown) item is a no-op. The status-guarded UPDATE means
 * only an OPEN row ever transitions, so two concurrent resolves of the same item can't double-apply, and a
 * replayed request never re-stamps a different responder over the first. Runs in a single transaction so the
 * closure check reads the item flip it just made.
 *
 * Concurrency: a FOR UPDATE lock on the parent scorecard row (taken at the top of the transaction)
 * serializes resolves for the same scorecard, so two responders closing out the last open items can't each
 * miss the other's uncommitted resolve and leave the scorecard stuck open.
 */
export async function resolveCorrectiveActionItem(
  db: TenantDb,
  input: ResolveCorrectiveActionInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize resolves for the SAME scorecard. Office transactions run at READ COMMITTED, so two
    // responders closing out the final two open items in separate transactions could each run their
    // `stillOpen` SELECT before seeing the other's uncommitted resolve → neither observes zero open
    // items → the scorecard is stuck `corrective_action_open` forever. Taking a FOR UPDATE row lock on
    // the parent scorecard makes the second resolve block until the first commits, after which its
    // `stillOpen` SELECT sees the now-committed resolve and closes the scorecard correctly.
    await tx
      .select({ id: fieldScorecards.id })
      .from(fieldScorecards)
      .where(eq(fieldScorecards.id, input.scorecardId))
      .limit(1)
      .for("update");

    const now = new Date();
    const updated = await tx
      .update(scorecardCorrectiveActions)
      .set({
        status: "resolved",
        responseComment: input.responseComment,
        respondedByUserId: input.respondedBy.userId,
        responderName: input.respondedBy.name,
        responderEmail: input.respondedBy.email,
        respondedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(scorecardCorrectiveActions.id, input.itemId),
          eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
          // Idempotent: only an OPEN item transitions. Already-resolved / unknown ids update no row.
          eq(scorecardCorrectiveActions.status, "open"),
        ),
      )
      .returning({ id: scorecardCorrectiveActions.id });

    if (updated.length === 0) return; // already resolved or not found — no-op.

    const stillOpen = await tx
      .select({ id: scorecardCorrectiveActions.id })
      .from(scorecardCorrectiveActions)
      .where(
        and(
          eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
          eq(scorecardCorrectiveActions.status, "open"),
        ),
      );

    if (stillOpen.length === 0) {
      await tx
        .update(fieldScorecards)
        .set({ status: "corrective_action_closed", updatedAt: new Date() })
        .where(eq(fieldScorecards.id, input.scorecardId));
    }
  });
}

export interface ReconcileCorrectiveActionsInput {
  scorecardId: string;
  dealId: string;
  /** Owning office (id + slug) — used to enqueue the notification job on a fresh open/re-open. */
  office: { id: string; slug: string };
  rating: ScorecardRating;
  actionItems: string[];
  deficiencies: string[];
  /** The scorecard's status BEFORE this reconcile (drives the enqueue-on-transition decision). */
  currentStatus: string;
}

/**
 * Reconcile a scorecard's corrective-action lifecycle against a freshly (re)computed rating + flagged
 * items. Called from BOTH createFieldScorecard (initial submit) and updateFieldScorecard (edit), in the
 * SAME transaction that persisted the card, so the two paths can never drift.
 *
 * Match key (the fragile-index note): a critical_deficiency is tracked by its deficiency KEY (item_ref —
 * stable across edits). An action_item's seed index (item_ref = String(idx)) is FRAGILE: reordering or
 * inserting an action item shifts every later index, so on edit we match action items by their itemLabel
 * (the action text) instead — a resolved "Verify hold points" stays matched even if its position moved.
 * Because item_ref is (scorecard_id, item_type, item_ref)-unique, a NEW action item is inserted with a
 * fresh monotonic item_ref (max existing numeric ref + 1…) so it never collides with a resolved row that
 * still occupies an old index.
 *
 * inBand (isCorrectiveActionBand && any flagged): INSERT newly-flagged items as `open`; DELETE any tracked
 * OPEN item whose flag is gone (a stale open item would block closure forever); LEAVE `resolved` items as
 * history. Then: if items exist and NONE are open → corrective_action_closed; else ensure
 * corrective_action_open. On a transition INTO open from a non-open status, (re)enqueue the notification
 * job AND reset corrective_action_email_sent_at = NULL so the worker sends; an already-open card does NOT
 * re-enqueue.
 *
 * NOT inBand (edit lifted the card above band / removed every flag): if currently corrective_action_open,
 * revert to `submitted` and DELETE the open items (now obsolete). A corrective_action_closed card is left
 * untouched — its resolved rows are history.
 */
export async function reconcileScorecardCorrectiveActions(
  tx: TenantDb,
  input: ReconcileCorrectiveActionsInput,
): Promise<void> {
  const inBand =
    isCorrectiveActionBand(input.rating) &&
    enumerateFlaggedItems({ actionItems: input.actionItems, criticalDeficiencies: input.deficiencies }).length > 0;
  const flagged = inBand
    ? enumerateFlaggedItems({ actionItems: input.actionItems, criticalDeficiencies: input.deficiencies })
    : [];

  const existing = await tx
    .select({
      id: scorecardCorrectiveActions.id,
      itemType: scorecardCorrectiveActions.itemType,
      itemRef: scorecardCorrectiveActions.itemRef,
      itemLabel: scorecardCorrectiveActions.itemLabel,
      status: scorecardCorrectiveActions.status,
    })
    .from(scorecardCorrectiveActions)
    .where(eq(scorecardCorrectiveActions.scorecardId, input.scorecardId));

  if (!inBand) {
    // The edit lifted the card out of the band (or removed every flag). Drop still-open items (obsolete) and,
    // if the card was open, walk it back to `submitted`. Resolved items + a closed card are left as history.
    const openIds = existing.filter((row) => row.status === "open").map((row) => row.id);
    if (openIds.length > 0) {
      await tx.delete(scorecardCorrectiveActions).where(inArray(scorecardCorrectiveActions.id, openIds));
    }
    if (input.currentStatus === "corrective_action_open") {
      await tx
        .update(fieldScorecards)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(eq(fieldScorecards.id, input.scorecardId));
    }
    return;
  }

  // Match each freshly-flagged item to an existing row by its STABLE key: deficiency → item_ref (the key),
  // action item → item_label (the text). A flagged item with no match is newly-flagged → insert as open.
  // A tracked OPEN item that is no longer flagged is stale → delete (else it blocks closure).
  const matchKey = (type: FlaggedItem["itemType"], ref: string, label: string) =>
    type === "critical_deficiency" ? `d:${ref}` : `a:${label}`;
  const existingByKey = new Map(
    existing.map((row) => [matchKey(row.itemType as FlaggedItem["itemType"], row.itemRef, row.itemLabel), row]),
  );
  const flaggedKeys = new Set(flagged.map((f) => matchKey(f.itemType, f.itemRef, f.itemLabel)));

  // A fresh action-item item_ref that never collides with an existing action_item row (the uniqueness key is
  // (scorecard_id, item_type, item_ref)). Deficiencies keep their key as item_ref (already stable + unique).
  let nextActionRef =
    existing
      .filter((row) => row.itemType === "action_item")
      .reduce((max, row) => Math.max(max, Number.parseInt(row.itemRef, 10) || 0), -1) + 1;

  const toInsert: FlaggedItem[] = [];
  for (const f of flagged) {
    if (existingByKey.has(matchKey(f.itemType, f.itemRef, f.itemLabel))) continue;
    toInsert.push(
      f.itemType === "critical_deficiency"
        ? f
        : { ...f, itemRef: String(nextActionRef++) },
    );
  }
  const staleOpenIds = existing
    .filter((row) => row.status === "open")
    .filter((row) => !flaggedKeys.has(matchKey(row.itemType as FlaggedItem["itemType"], row.itemRef, row.itemLabel)))
    .map((row) => row.id);

  if (staleOpenIds.length > 0) {
    await tx.delete(scorecardCorrectiveActions).where(inArray(scorecardCorrectiveActions.id, staleOpenIds));
  }
  if (toInsert.length > 0) {
    await tx.insert(scorecardCorrectiveActions).values(
      toInsert.map((f) => ({
        scorecardId: input.scorecardId,
        itemType: f.itemType,
        itemRef: f.itemRef,
        itemLabel: f.itemLabel,
        status: "open" as const,
      })),
    );
  }

  // Recompute open/closed from the post-reconcile set: surviving resolved rows + surviving open rows + inserts.
  const survivingOpen = existing.filter(
    (row) => row.status === "open" && !staleOpenIds.includes(row.id),
  ).length;
  const openCount = survivingOpen + toInsert.length;
  const anyItems = existing.length - staleOpenIds.length + toInsert.length > 0;

  let nextStatus: "corrective_action_open" | "corrective_action_closed";
  if (anyItems && openCount === 0) {
    nextStatus = "corrective_action_closed";
  } else {
    nextStatus = "corrective_action_open";
  }
  if (input.currentStatus !== nextStatus) {
    await tx
      .update(fieldScorecards)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(fieldScorecards.id, input.scorecardId));
  }

  // A transition INTO open from a non-open state (fresh submit, or an edit re-opening a closed/submitted
  // card) (re)enqueues the notification + clears the email stamp so the worker sends again. An already-open
  // card does NOT re-enqueue (the original job is still the notification of record).
  const transitioningIntoOpen =
    nextStatus === "corrective_action_open" && input.currentStatus !== "corrective_action_open";
  if (transitioningIntoOpen) {
    await tx
      .update(fieldScorecards)
      .set({ correctiveActionEmailSentAt: null })
      .where(eq(fieldScorecards.id, input.scorecardId));
    await tx.insert(jobQueue).values({
      jobType: SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB,
      payload: {
        tenantSchema: `office_${input.office.slug}`,
        scorecardId: input.scorecardId,
        dealId: input.dealId,
        officeId: input.office.id,
      },
      officeId: input.office.id,
      status: "pending",
      runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
      maxAttempts: 6,
    });
  }
}
