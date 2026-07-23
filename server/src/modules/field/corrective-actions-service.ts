import { randomUUID } from "node:crypto";
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

/** The shape of an existing scorecard_corrective_actions row as read by the reconcile SELECT. */
interface ExistingCorrectiveActionRow {
  id: string;
  itemType: string;
  itemRef: string;
  itemLabel: string;
  status: string;
}

/**
 * Ids of RESOLVED rows whose item is NO LONGER FLAGGED in the current edit — the parallel of the in-band
 * "removed item ⇒ delete its resolved row too" cleanup, factored out so BOTH reconcile paths purge stale
 * resolved history identically.
 *
 * Why the not-inBand path needs this: without it, a resolved row for a removed flag survives when the card
 * leaves the band. If the SAME deficiency/action is re-added later and the card drops back in-band, that stale
 * resolved row satisfies the membership check → NO open row is inserted → openCount stays 0 → the card stays
 * closed and nobody is notified of the recurring deficiency (the reopen-recurrence bug). Purging the removed
 * items' resolved rows here means a later re-add always inserts a fresh open row (reopening + re-notifying).
 *
 * Match keys mirror the in-band reconcile exactly: a critical_deficiency is matched by its ref (unique per
 * card); action_items match by LABEL AND CARDINALITY (a multiset) — a still-flagged label keeps up to
 * flaggedCount resolved rows, the SURPLUS resolved rows (and every resolved row for a label flagged zero
 * times) are removed. A STILL-flagged item's resolved row is PRESERVED so it does not reopen if the card later
 * drops back in-band (a resolved-but-still-flagged item must stay resolved history).
 */
function resolvedIdsForNoLongerFlaggedItems(
  existing: readonly ExistingCorrectiveActionRow[],
  flaggedDeficiencyRefs: ReadonlySet<string>,
  flaggedActionCountByLabel: ReadonlyMap<string, number>,
): string[] {
  const removed: string[] = [];

  // Deficiencies: a resolved row whose ref is no longer flagged is stale history.
  for (const row of existing) {
    if (row.itemType !== "critical_deficiency" || row.status !== "resolved") continue;
    if (!flaggedDeficiencyRefs.has(row.itemRef)) removed.push(row.id);
  }

  // Action items: per label, keep up to flaggedCount resolved rows (still-flagged history), delete the surplus.
  const resolvedActionByLabel = new Map<string, ExistingCorrectiveActionRow[]>();
  for (const row of existing) {
    if (row.itemType !== "action_item" || row.status !== "resolved") continue;
    const bucket = resolvedActionByLabel.get(row.itemLabel) ?? [];
    bucket.push(row);
    resolvedActionByLabel.set(row.itemLabel, bucket);
  }
  for (const [label, bucket] of resolvedActionByLabel) {
    const keep = flaggedActionCountByLabel.get(label) ?? 0;
    for (let i = keep; i < bucket.length; i++) removed.push(bucket[i].id);
  }

  return removed;
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
 * revert to `submitted` and DELETE the open items (now obsolete). ALSO purge RESOLVED rows for items no longer
 * flagged in this edit — the same removed-item cleanup the in-band path applies, so a later re-add of that
 * flag reopens with a fresh open row instead of matching a stale resolved row (the reopen-recurrence bug). A
 * STILL-flagged item's resolved row is preserved (it must not reopen if the card later drops back in-band);
 * when ALL flags are removed, every resolved row goes. Note the same intended history trade-off as the in-band
 * path: a removed item's resolved history is dropped so recurrence re-notifies.
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
    // if the card was open, walk it back to `submitted`.
    //
    // Also purge RESOLVED rows for items that are NO LONGER FLAGGED in this edit — the SAME "removed item ⇒
    // delete its resolved row too" cleanup the in-band path applies. Without it, a resolved row for a removed
    // flag survives; re-adding that flag later (card back in-band) would find the stale resolved row, insert
    // NO open row, and silently keep the card closed with nobody notified (the reopen-recurrence bug). A
    // STILL-flagged item's resolved row is PRESERVED (it must not reopen if the card drops back in-band). When
    // ALL flags are removed → every resolved row is stale → all go. The "still flagged" set comes from THIS
    // edit's raw flags (enumerated regardless of band, since `flagged` is empty in the not-inBand branch).
    const stillFlagged = enumerateFlaggedItems({
      actionItems: input.actionItems,
      criticalDeficiencies: input.deficiencies,
    });
    const flaggedDeficiencyRefs = new Set(
      stillFlagged.filter((f) => f.itemType === "critical_deficiency").map((f) => f.itemRef),
    );
    const flaggedActionCountByLabel = new Map<string, number>();
    for (const f of stillFlagged) {
      if (f.itemType !== "action_item") continue;
      flaggedActionCountByLabel.set(f.itemLabel, (flaggedActionCountByLabel.get(f.itemLabel) ?? 0) + 1);
    }
    const staleResolvedIds = resolvedIdsForNoLongerFlaggedItems(
      existing,
      flaggedDeficiencyRefs,
      flaggedActionCountByLabel,
    );
    const openIds = existing.filter((row) => row.status === "open").map((row) => row.id);
    const idsToDelete = [...openIds, ...staleResolvedIds];
    if (idsToDelete.length > 0) {
      await tx.delete(scorecardCorrectiveActions).where(inArray(scorecardCorrectiveActions.id, idsToDelete));
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
  // insert as open; STILL-flagged-but-trimmed OPEN rows → delete (else they block closure); rows for a flag
  // that is NO LONGER present at all (removed from this edit) → delete EVEN IF resolved. A STILL-flagged
  // item's resolved row is preserved as history (it must not reopen on every edit); a REMOVED item's resolved
  // row is dropped — it's no longer part of the scorecard's assessment, and keeping it would let a later
  // re-add of the same flag find a stale resolved row that satisfies the membership check, insert NO open
  // row, leave openCount == 0, and silently keep a recurring critical deficiency's card closed with nobody
  // notified (the reopen-recurrence bug). Dropping the removed item's history is the intended trade-off.
  //
  // Deficiencies match by their KEY (item_ref) — a deficiency key is unique per card, so a plain key match
  // is correct. Action items match by LABEL AND CARDINALITY (a MULTISET): two action items with identical
  // text are TWO distinct flags and must yield TWO tracked rows. A plain by-label match would collapse both
  // onto one existing row, so the second flag would never be inserted — then resolving the single row could
  // close the card while a duplicate flag has no response. So for each label we match up to
  // min(existingCount, flaggedCount) rows (those stay as-is), insert the surplus flags, and delete the
  // surplus (deleting OPEN duplicates first, preserving resolved history — UNLESS the label is removed
  // entirely (flaggedCount == 0), in which case every row for it is dropped, resolved history included).
  const toInsert: FlaggedItem[] = [];
  // Rows to delete: OPEN rows trimmed while their flag is still present, PLUS both open AND resolved rows for
  // a flag that is no longer present at all (a removed item) — see the reopen-recurrence rationale above.
  const staleIds: string[] = [];

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
    if (row.itemType !== "critical_deficiency") continue;
    // A deficiency ref no longer flagged in THIS edit (removed) → delete its row whether open OR resolved, so
    // a later re-add inserts a fresh open row (reopening + re-notifying). A still-flagged deficiency's row is
    // left untouched (a resolved one stays as history and must NOT reopen on an unrelated edit).
    if (!flaggedDeficiencyRefs.has(row.itemRef)) staleIds.push(row.id);
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
  // Trim per label. Two cases:
  //   - Label REMOVED entirely (flaggedCount == 0): delete ALL its rows, resolved history included, so a
  //     later re-add of that label inserts a fresh open row (reopening) rather than matching a stale resolved
  //     row that would leave openCount == 0. Mirror of the deficiency treatment (the reopen-recurrence fix).
  //   - Label STILL present but over-supplied (existingCount > flaggedCount > 0): trim only the surplus,
  //     deleting OPEN duplicates first and preserving resolved history (bucket is resolved-first, so we walk
  //     from the END). A still-flagged label's resolved row must NOT reopen on every edit.
  for (const [label, bucket] of existingActionByLabel) {
    const flaggedCount = flaggedActionCountByLabel.get(label) ?? 0;
    if (flaggedCount === 0) {
      for (const row of bucket) staleIds.push(row.id);
      continue;
    }
    let surplus = bucket.length - flaggedCount;
    for (let i = bucket.length - 1; i >= 0 && surplus > 0; i--) {
      if (bucket[i].status === "open") {
        staleIds.push(bucket[i].id);
        surplus--;
      }
    }
  }

  if (staleIds.length > 0) {
    await tx.delete(scorecardCorrectiveActions).where(inArray(scorecardCorrectiveActions.id, staleIds));
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
  // survivingOpen already restricts to status === "open", so deleted resolved rows (now also in staleIds) can't
  // perturb it; anyItems subtracts every deleted row (open + resolved) from the pre-reconcile count.
  const survivingOpen = existing.filter(
    (row) => row.status === "open" && !staleIds.includes(row.id),
  ).length;
  const openCount = survivingOpen + toInsert.length;
  const anyItems = existing.length - staleIds.length + toInsert.length > 0;

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
        // Per-cycle nonce: a stable, persisted idempotency-cycle dimension for the worker's CRM (no-token)
        // Resend key. A new nonce is minted for EACH enqueue (each corrective-action cycle — a fresh submit,
        // a reopen, or an already-open card that gained work), so it DIFFERS across cycles yet is immutable
        // for a job's lifetime — i.e. STABLE across a genuine queue retry. The worker keys off this instead
        // of hashing the currently-open corrective-action rows, whose ids shift if a responder resolves an
        // item between the send attempt and a retry (a different hash → a different key → Resend won't dedup
        // → a duplicate email). See the worker handler's idempotency-key derivation.
        cycleNonce: randomUUID(),
      },
      officeId: input.office.id,
      status: "pending",
      runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
      maxAttempts: 6,
    });
  }
}
