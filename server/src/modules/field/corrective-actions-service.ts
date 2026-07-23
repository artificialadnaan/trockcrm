import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  fieldScorecards,
  jobQueue,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
} from "@trock-crm/shared/schema";
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
    await resolveCorrectiveActionItemTx(tx, input);
  });
}

/**
 * The transaction-scoped body of resolveCorrectiveActionItem: takes the parent-scorecard FOR UPDATE lock,
 * status-guards the item flip, and auto-closes the scorecard when it was the last open item. Runs inside a
 * caller-supplied transaction so the response-photo write and this resolve are atomic (spec §8) — a caller
 * that has already inserted response photos in the SAME tx rolls both back together on failure, and a
 * concurrent/stale submit whose item is no longer `open` never leaves orphan photos (the caller checks the
 * status under the same lock before inserting). See resolveCorrectiveActionItem for the concurrency rationale.
 *
 * Returns true when it flipped an open item to resolved, false when the item was already resolved / unknown
 * (the idempotent no-op) — the caller uses this to decide whether the write is the winning one.
 */
export async function resolveCorrectiveActionItemTx(
  tx: TenantDb,
  input: ResolveCorrectiveActionInput,
): Promise<boolean> {
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

  if (updated.length === 0) return false; // already resolved or not found — no-op.

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
  return true;
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
 * job AND reset corrective_action_email_sent_at = NULL so the worker sends. An already-open card that
 * MATERIALLY GAINS new open work (an edit inserted a fresh flag) ALSO starts a new cycle — but only if its
 * original notification already sent (email_sent_at non-null); if the original job is still pending it reads
 * items fresh at send time, so a second enqueue would double-send.
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

  // Read the current email-sent stamp: an already-open card that GAINS new flagged work must start a fresh
  // notification cycle, but ONLY if the original notification already went out (stamp non-null). If the
  // original job is still pending (stamp null) it reads items fresh at send time — so it'll already include
  // the newly-added flags and a second enqueue would double-send.
  const [{ correctiveActionEmailSentAt } = { correctiveActionEmailSentAt: null }] = await tx
    .select({ correctiveActionEmailSentAt: fieldScorecards.correctiveActionEmailSentAt })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, input.scorecardId))
    .limit(1);

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
      // The corrective-action cycle no longer exists (the edit lifted the card out of the band / removed every
      // flag), so its outstanding recipient-bound web tokens must not keep authorizing the responder flow or the
      // token-scoped upload routes until they expire. Revoke them on the same transition — same invariant the
      // reopen path enforces (a surviving token ⟺ a live corrective-action cycle). A card that had no email-only
      // recipient has no tokens, so this is a no-op there.
      await tx
        .delete(scorecardCorrectiveActionTokens)
        .where(eq(scorecardCorrectiveActionTokens.scorecardId, input.scorecardId));
    }
    return;
  }

  // Match freshly-flagged items to existing rows by their STABLE key, then reconcile: unmatched flags →
  // insert as open; tracked OPEN rows with no matching flag → delete (else they block closure). Resolved rows
  // are always preserved as history.
  //
  // Deficiencies match by their KEY (item_ref) — a deficiency key is unique per card, so a plain key match
  // is correct. Action items match by LABEL AND CARDINALITY (a MULTISET): two action items with identical
  // text are TWO distinct flags and must yield TWO tracked rows. A plain by-label match would collapse both
  // onto one existing row, so the second flag would never be inserted — then resolving the single row could
  // close the card while a duplicate flag has no response. So for each label we match up to
  // min(existingCount, flaggedCount) rows (those stay as-is), insert the surplus flags, and delete surplus
  // OPEN rows (preferring to keep resolved rows as history when trimming duplicates).
  const toInsert: FlaggedItem[] = [];
  const staleOpenIds: string[] = [];

  // ── Deficiencies: unique-key match. ──────────────────────────────────────────
  const existingDeficiencyByRef = new Map(
    existing.filter((row) => row.itemType === "critical_deficiency").map((row) => [row.itemRef, row]),
  );
  const flaggedDeficiencyRefs = new Set(
    flagged.filter((f) => f.itemType === "critical_deficiency").map((f) => f.itemRef),
  );
  for (const f of flagged) {
    if (f.itemType !== "critical_deficiency") continue;
    if (!existingDeficiencyByRef.has(f.itemRef)) toInsert.push(f);
  }
  for (const row of existing) {
    if (row.itemType !== "critical_deficiency" || row.status !== "open") continue;
    if (!flaggedDeficiencyRefs.has(row.itemRef)) staleOpenIds.push(row.id);
  }

  // ── Action items: multiset (label + cardinality) match. ──────────────────────
  // A fresh action-item item_ref that never collides with an existing action_item row (the uniqueness key is
  // (scorecard_id, item_type, item_ref)). Grows monotonically as inserts are minted below.
  let nextActionRef =
    existing
      .filter((row) => row.itemType === "action_item")
      .reduce((max, row) => Math.max(max, Number.parseInt(row.itemRef, 10) || 0), -1) + 1;
  // Group existing action rows by label — resolved rows FIRST so, when trimming a surplus, we keep resolved
  // history and delete the open duplicates.
  const existingActionByLabel = new Map<string, typeof existing>();
  for (const row of existing) {
    if (row.itemType !== "action_item") continue;
    const bucket = existingActionByLabel.get(row.itemLabel) ?? [];
    bucket.push(row);
    existingActionByLabel.set(row.itemLabel, bucket);
  }
  for (const bucket of existingActionByLabel.values()) {
    bucket.sort((a, b) => (a.status === "resolved" ? 0 : 1) - (b.status === "resolved" ? 0 : 1));
  }
  const flaggedActionCountByLabel = new Map<string, number>();
  for (const f of flagged) {
    if (f.itemType !== "action_item") continue;
    flaggedActionCountByLabel.set(f.itemLabel, (flaggedActionCountByLabel.get(f.itemLabel) ?? 0) + 1);
  }
  // Insert the surplus flags per label (flaggedCount - existingCount, when positive).
  for (const [label, flaggedCount] of flaggedActionCountByLabel) {
    const existingCount = existingActionByLabel.get(label)?.length ?? 0;
    for (let i = existingCount; i < flaggedCount; i++) {
      toInsert.push({ itemType: "action_item", itemRef: String(nextActionRef++), itemLabel: label });
    }
  }
  // Delete surplus OPEN existing rows per label (existingCount - flaggedCount, when positive). The bucket is
  // resolved-first, so we walk from the END (open rows) to trim, never touching resolved history.
  for (const [label, bucket] of existingActionByLabel) {
    const flaggedCount = flaggedActionCountByLabel.get(label) ?? 0;
    let surplus = bucket.length - flaggedCount;
    for (let i = bucket.length - 1; i >= 0 && surplus > 0; i--) {
      if (bucket[i].status === "open") {
        staleOpenIds.push(bucket[i].id);
        surplus--;
      }
    }
  }

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

  // Decide whether to (re)start a notification cycle. Two triggers, UNIFIED into one enqueue site:
  //   1) transitioningIntoOpen — a transition INTO open from a non-open state (fresh submit, or an edit
  //      re-opening a closed/submitted card). Always (re)notifies.
  //   2) alreadyOpenGainedWork — an already-open card that MATERIALLY GAINS new open work (an edit
  //      added/replaced a flag → toInsert.length > 0). Without this, recipients only ever got the email
  //      describing the OLD flags and never learn of the newly-assigned corrective action. But only notify
  //      if the ORIGINAL job already SENT (correctiveActionEmailSentAt non-null): if it's still pending it
  //      reads items fresh at send time and will already include the new flags, so a second enqueue would
  //      double-send.
  const transitioningIntoOpen =
    nextStatus === "corrective_action_open" && input.currentStatus !== "corrective_action_open";
  const alreadyOpenGainedWork =
    nextStatus === "corrective_action_open" &&
    input.currentStatus === "corrective_action_open" &&
    toInsert.length > 0 &&
    correctiveActionEmailSentAt !== null;
  if (transitioningIntoOpen || alreadyOpenGainedWork) {
    await tx
      .update(fieldScorecards)
      .set({ correctiveActionEmailSentAt: null })
      .where(eq(fieldScorecards.id, input.scorecardId));
    // Starting a NEW notification cycle (a reopen, OR an already-open card that gained new work after its
    // original email sent), prior-cycle web tokens must not survive it. The worker's per-recipient reuse-skip
    // treats a surviving unexpired token as "already delivered THIS cycle" and skips re-sending — which, across
    // a new cycle, would silently strand the email-only recipient on the old cycle's link while the job stamps
    // the new cycle as sent. Deleting the outstanding tokens here keeps that invariant true (a surviving token
    // ⟺ a same-cycle delivery), so the worker re-mints + re-sends a fresh link. A fresh submit has no tokens to
    // delete, so this is a no-op there.
    await tx
      .delete(scorecardCorrectiveActionTokens)
      .where(eq(scorecardCorrectiveActionTokens.scorecardId, input.scorecardId));
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
