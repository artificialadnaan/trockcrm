import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
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
// The OVERSIGHT notification (FIELD_SCORECARD_EMAIL_RECIPIENTS watchers) — a SEPARATE job from the responder
// one above, because the responder email carries a per-recipient token that authorizes answering and must
// never reach an oversight inbox. MUST match the worker's
// registerJobHandler(SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB, ...).
const SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB = "scorecard_corrective_action_oversight_email";
// Give the synchronous PDF render + R2 upload a head start over the worker's poll (mirrors the
// field_scorecard_email delay). run_after is a short while in the future so the email doesn't race the poll.
const SCORECARD_EMAIL_RUN_AFTER_SECONDS = 120;

/**
 * A STRICTLY INCREASING scorecard generation token.
 *
 * `field_scorecards.updated_at` is the PDF artifact's staleness token (migration 0200) AND the single-flight
 * key for finalizeFieldScorecardArtifacts. A bare `new Date()` can land in the SAME millisecond as the write
 * before it — two responders answering the final two items typically commit microseconds apart — and then:
 *   - the publish CAS (`date_trunc('milliseconds', updated_at) = <read generation>`) still passes, so a render
 *     that read the PRE-second-resolve state stamps its stale bytes as current; and
 *   - needsScorecardPdfRegeneration sees rendered == current and never repairs it, permanently.
 *   - the second finalize builds the same single-flight key and coalesces onto the stale in-flight render.
 * Matches the expression scorecard evidence invalidation already uses for exactly this reason
 * (modules/files/service.ts) and the +1ms guard on the scorecard edit path (scorecards-service.ts).
 *
 * Built per call rather than held in a module-level constant: a top-level `sql` template dereferences
 * `fieldScorecards.updatedAt` at IMPORT time, which throws for any consumer that partially mocks
 * `@trock-crm/shared/schema` — and this module is reachable from the auth and deal import graphs.
 */
function nextGeneration() {
  return sql`GREATEST(${fieldScorecards.updatedAt} + interval '1 millisecond', NOW())`;
}

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
 * Returns `{ resolved, closed }`: `resolved` is true when it flipped an open item (false on the idempotent
 * no-op — an already-resolved or unknown id), and `closed` is true only on the winning write that answered
 * the LAST open item. The caller uses `closed` to fire the oversight "completed" notification exactly once.
 */
export async function resolveCorrectiveActionItemTx(
  tx: TenantDb,
  input: ResolveCorrectiveActionInput,
): Promise<{ resolved: boolean; closed: boolean }> {
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

  if (updated.length === 0) return { resolved: false, closed: false }; // already resolved / unknown — no-op.

  const stillOpen = await tx
    .select({ id: scorecardCorrectiveActions.id })
    .from(scorecardCorrectiveActions)
    .where(
      and(
        eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
        eq(scorecardCorrectiveActions.status, "open"),
      ),
    );

  // Advance the scorecard generation on EVERY winning resolve, not only on the auto-close.
  //
  // The stored PDF artifact's staleness is keyed on updated_at (migration 0200), so without this a response
  // to item 1 of 3 would leave the download serving the pre-corrective-action PDF — the reported bug. It is
  // also what makes finalizeFieldScorecardArtifacts' single-flight key (updated_at) start a FRESH render
  // rather than coalescing onto a stale in-flight one.
  //
  // Only reached when `updated.length > 0` — an idempotent re-resolve returned false above — so a duplicate
  // submit does not churn the artifact.
  const closing = stillOpen.length === 0;
  await tx
    .update(fieldScorecards)
    .set(
      closing
        ? { status: "corrective_action_closed", updatedAt: nextGeneration() }
        : { updatedAt: nextGeneration() },
    )
    .where(eq(fieldScorecards.id, input.scorecardId));

  return { resolved: true, closed: closing };
}

/**
 * Enqueue the OVERSIGHT "completed" notification for a scorecard that just auto-closed. Called from the
 * responder funnel inside the SAME transaction as the closing resolve, so the job cannot exist for a close
 * that rolled back.
 *
 * Carries the scorecard's CURRENT corrective_action_cycle_nonce so the Resend idempotency key is distinct
 * per cycle. The worker never compares that nonce against the stored value — see the handler's dedup note —
 * so a nonce rotated by the responder job's self-repair path cannot strand this notice.
 *
 * Only the winning close reaches here (resolveCorrectiveActionItemTx returns closed: true exactly once), and
 * the worker's own closed-stamp is the second line of defence against a duplicate send.
 */
export async function enqueueCorrectiveActionOversightClosed(
  tx: TenantDb,
  input: { office: { id: string; slug: string }; scorecardId: string },
): Promise<void> {
  const [card] = await tx
    .select({
      dealId: fieldScorecards.dealId,
      cycleNonce: fieldScorecards.correctiveActionCycleNonce,
      oversightCycle: fieldScorecards.correctiveActionOversightCycle,
    })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, input.scorecardId))
    .limit(1);
  // The row is guaranteed present here (the caller just resolved an item on it under a FOR UPDATE lock),
  // but bail rather than enqueue a job with a null dealId whose email would have no CRM link.
  if (!card) return;

  await tx.insert(jobQueue).values({
    jobType: SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB,
    payload: {
      tenantSchema: `office_${input.office.slug}`,
      scorecardId: input.scorecardId,
      dealId: card.dealId,
      officeId: input.office.id,
      phase: "closed",
      // Null on a legacy card that predates the cycle-nonce column; the worker falls back to a "none"
      // dimension, which is still phase- and scorecard-scoped.
      cycleNonce: card.cycleNonce ?? undefined,
      // Carries the marker CURRENT at close. A later reopen rotates it, so this job refuses to send a
      // "completed" notice for a card that has since gone back to the responders.
      oversightCycle: card.oversightCycle ?? undefined,
    },
    officeId: input.office.id,
    status: "pending",
    // The completed notice attaches the refreshed PDF, which the route re-renders post-commit. Reuse the
    // same head start the other scorecard emails take so the attachment is normally ready.
    runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
    maxAttempts: 6,
  });
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
  /**
   * True when this edit CHANGED which field-responder the card points at for either role (its
   * superintendent_responder_id / pm_responder_id). Recipient resolution is scorecard-scoped, so that swap
   * changes WHO the corrective action is addressed to — the same class of event as a super/PM reassignment on
   * the Team tab, which already restarts the notification cycle. Defaults false (the create path can't have
   * changed anything).
   */
  responderPickChanged?: boolean;
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
 * NOT inBand (edit lifted the card above band / removed every flag): if currently corrective_action_open OR
 * corrective_action_closed, revert to `submitted` and DELETE the open items (now obsolete) — a closed card
 * whose corrective rows no longer apply must not keep showing a resolved corrective action. ALSO purge
 * RESOLVED rows for items no longer
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
    // Walk the card back to `submitted` from EITHER open OR closed. An OPEN card that leaves the band obviously
    // has no live corrective action; but a CLOSED card whose corrective rows are removed / no longer apply must
    // ALSO revert — otherwise the QC report + mobile/deal status badges keep showing a "resolved corrective
    // action" that no longer exists. Both are corrective-action statuses that must not survive an edit that
    // dropped the card out of the band / removed every flag.
    if (
      input.currentStatus === "corrective_action_open" ||
      input.currentStatus === "corrective_action_closed"
    ) {
      await tx
        .update(fieldScorecards)
        .set({ status: "submitted", updatedAt: nextGeneration() })
        .where(eq(fieldScorecards.id, input.scorecardId));
      // The corrective-action cycle no longer exists (the edit lifted the card out of the band / removed every
      // flag), so its outstanding recipient-bound web tokens must not keep authorizing the responder flow or the
      // token-scoped upload routes until they expire. Revoke them on the same transition — same invariant the
      // reopen path enforces (a surviving token ⟺ a live corrective-action cycle), applied to the closed→submitted
      // transition too. A card that had no email-only recipient has no tokens, so this is a no-op there.
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
  //     deleting OPEN duplicates FIRST and preserving resolved history where possible (bucket is resolved-first,
  //     so we walk from the END to hit the open rows first). But if the surplus is NOT fully covered by open
  //     rows — e.g. BOTH duplicates were resolved and the label drops to one occurrence — the remaining surplus
  //     MUST also delete the extra RESOLVED rows so existingCount falls to flaggedCount. Otherwise the surplus
  //     resolved rows survive, existingCount stays too high, and a later re-add of the duplicate inserts NO
  //     fresh open row → the recurring duplicate is never reopened/notified. "Prefer open, keep resolved
  //     history when possible" still holds: at least (bucket.length - surplus) = flaggedCount rows survive, and
  //     resolved rows are only removed once every open duplicate has already been taken.
  for (const [label, bucket] of existingActionByLabel) {
    const flaggedCount = flaggedActionCountByLabel.get(label) ?? 0;
    if (flaggedCount === 0) {
      for (const row of bucket) staleIds.push(row.id);
      continue;
    }
    let surplus = bucket.length - flaggedCount;
    // Walk from the END (open rows are last, since the bucket is resolved-first). Delete whatever is at the
    // tail — open duplicates go before any resolved row is touched, but once the open duplicates are exhausted
    // the still-positive surplus falls through onto the trailing resolved rows so the count reaches flaggedCount.
    for (let i = bucket.length - 1; i >= 0 && surplus > 0; i--) {
      staleIds.push(bucket[i].id);
      surplus--;
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
      .set({ status: nextStatus, updatedAt: nextGeneration() })
      .where(eq(fieldScorecards.id, input.scorecardId));
  }

  // An EDIT can close the card too, not just a responder answering the last item: deleting the text of the
  // only still-open flag leaves `anyItems` true with `openCount === 0`, so this reconcile flips the card to
  // corrective_action_closed. Without an enqueue here, oversight — which was told the corrective action
  // opened — would never learn it completed, and nothing would ever enqueue for it again.
  //
  // Distinct from the CANCEL path (an edit lifting the card above band), which walks it to `submitted` and
  // deletes its items in the not-in-band branch above; that is not a completion and stays silent.
  if (nextStatus === "corrective_action_closed" && input.currentStatus !== "corrective_action_closed") {
    await enqueueCorrectiveActionOversightClosed(tx, {
      office: input.office,
      scorecardId: input.scorecardId,
    });
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
  //   3) alreadyOpenResponderChanged — an already-open card whose PICKED super/PM changed. Recipients resolve
  //      per-card from that pick, so the swap both revokes the previous holder (their email no longer resolves,
  //      and the verify-time revalidation 403s their outstanding link) and leaves the new person holding
  //      nothing. Restarting the cycle re-mints + re-sends for the new recipient set — the same remedy
  //      restartCorrectiveActionNotificationCycleForDeal already applies to a Team-tab reassignment.
  //
  //      UNCONDITIONAL — unlike (2), this does NOT ask whether the email already went out or whether some job
  //      might still deliver. Every "is a job still coming?" test is a race: the worker resolves recipients,
  //      sends, then RE-resolves before stamping, and none of that is atomic with this transaction. A job that
  //      re-read the OLD pick just before this edit commits will then block on the card row, acquire it after
  //      the commit, and stamp successfully — because nothing rotated the cycle nonce. The old recipient is
  //      left holding a link that now 403s, the new pick has neither token nor email, and the stamp suppresses
  //      any further send: unanswerable by anyone.
  //
  //      Restarting unconditionally is safe precisely because the cycle nonce already exists to supersede: a
  //      still-pending job whose payload nonce no longer matches the stored one returns early with NO send and
  //      NO stamp, and an in-flight job's stamp updates 0 rows. So the fresh cycle is the only delivery, which
  //      is what makes "a second enqueue would double-send" untrue here — that worry is what the nonce solved.
  //
  //      NOTE: (2) above still gates on the stamp and inherits the same race. Left as-is on purpose — it is
  //      pre-existing and strictly milder there (the existing recipients keep working links and merely miss the
  //      new item), whereas here it strands the card. Worth its own change, not a silent widening.
  const alreadyOpenResponderChanged =
    nextStatus === "corrective_action_open" &&
    input.currentStatus === "corrective_action_open" &&
    input.responderPickChanged === true;
  if (transitioningIntoOpen || alreadyOpenGainedWork || alreadyOpenResponderChanged) {
    // Mint the per-cycle nonce ONCE and use it in BOTH places: (a) persisted on the scorecard as the ACTIVE
    // cycle's nonce, and (b) the enqueued job's payload.cycleNonce. Keeping them equal is what lets the
    // worker's final delivery stamp require `corrective_action_cycle_nonce = payload.cycleNonce` — a
    // stale-cycle job (superseded by a later edit that minted a new nonce here) then updates 0 rows and does
    // NOT stamp, so the current cycle's matching-nonce job is the one that stamps.
    const cycleNonce = randomUUID();
    // A separate identity for the oversight flow — see the field-scorecards schema comment.
    const oversightCycle = randomUUID();
    // Reset the sent stamp AND stamp the active cycle nonce together (fresh cycle → the worker must send).
    await tx
      .update(fieldScorecards)
      .set({
        correctiveActionEmailSentAt: null,
        correctiveActionCycleNonce: cycleNonce,
        // The OVERSIGHT stamps clear ONLY on a genuine (re)open — NOT on the other two triggers of this
        // block. Both `alreadyOpenGainedWork` and `alreadyOpenResponderChanged` require the card to have
        // been ALREADY open, so from oversight's point of view nothing new happened: it was told once when
        // the corrective action opened and will be told once when it completes. Clearing here would re-send
        // "opened" every time an edit adds a flag or corrects a mis-picked superintendent — exactly the
        // inbox noise this feature avoids, and the same reason the restart helpers don't clear them.
        ...(transitioningIntoOpen
          ? {
              correctiveActionOversightOpenedAt: null,
              correctiveActionOversightClosedAt: null,
              // Rotate the INDEPENDENT oversight marker. Unlike the shared cycle nonce (which the responder
              // worker's self-repair also rotates), this moves ONLY here, so the oversight handler can gate
              // its SEND on it without conflating supersession with self-repair. Retiring queued jobs below
              // is not sufficient alone: a job already CLAIMED by a worker is past that point.
              correctiveActionOversightCycle: oversightCycle,
            }
          : {}),
      })
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
        // → a duplicate email). See the worker handler's idempotency-key derivation. This is the SAME nonce
        // persisted on the scorecard above (corrective_action_cycle_nonce), so the worker's delivery stamp
        // can require it to still be the ACTIVE cycle at stamp time.
        cycleNonce,
      },
      officeId: input.office.id,
      status: "pending",
      runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
      maxAttempts: 6,
    });

    // Tell OVERSIGHT the corrective action opened — a separate job carrying the SAME cycleNonce, so both
    // notifications agree on which cycle they belong to. Never a CC on the job above: that one embeds a
    // per-recipient token authorizing a response, which must not reach an oversight inbox.
    //
    // Gated on transitioningIntoOpen ALONE, matching the stamp clearing above. The other two triggers of
    // this block operate on a card that was already open, which is not news for oversight.
    if (transitioningIntoOpen) {
      // RETIRE any oversight job still queued from a PRIOR cycle before enqueueing this one.
      //
      // Without this, a job minted for cycle A can start after the reopen that created cycle B: it reads B's
      // still-open status and B's freshly-cleared stamp, so it sends — under A's idempotency key, which
      // Resend will not dedup against B's. A's nonce-scoped stamp then correctly writes nothing, B's own job
      // sends too, and oversight gets the same notice twice.
      //
      // Cancelling at the source is better than a pre-send nonce check in the worker, because the worker
      // cannot distinguish "my cycle was superseded" from "the responder job's self-repair rotated the
      // shared nonce without starting a new cycle" — and returning early on the latter would strand the
      // notice entirely. The reopen knows exactly which jobs are stale, so it says so.
      //
      // Only `pending` rows are retired: a claimed/processing job is already past this point, and the
      // nonce-scoped stamp is what covers that much narrower in-flight window.
      await tx.execute(sql`
        UPDATE public.job_queue
           SET status = 'dead',
               last_error = 'superseded by a newer corrective-action cycle'
         WHERE job_type = ${SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB}
           AND status = 'pending'
           AND payload->>'scorecardId' = ${input.scorecardId}
      `);
      await tx.insert(jobQueue).values({
        jobType: SCORECARD_CORRECTIVE_ACTION_OVERSIGHT_EMAIL_JOB,
        payload: {
          tenantSchema: `office_${input.office.slug}`,
          scorecardId: input.scorecardId,
          dealId: input.dealId,
          officeId: input.office.id,
          phase: "opened",
          cycleNonce,
          oversightCycle,
        },
        officeId: input.office.id,
        status: "pending",
        runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
        maxAttempts: 6,
      });
    }
  }
}

/**
 * Start a FRESH notification cycle for every OPEN corrective-action scorecard on a deal. Called when the deal's
 * super/PM responder assignment changes (a removal or a re-role off the responder roles) so a newly-assigned
 * responder is actually NOTIFIED of the existing open corrective actions — the worker's per-send recipient
 * revalidation only covers a change that happens DURING an active send, not a reassignment that lands after the
 * original cycle already stamped as sent, so without this the replacement responder is authorized but silently
 * unnotified.
 *
 * For each field_scorecards row on the deal with status = 'corrective_action_open':
 *   - reset corrective_action_email_sent_at = NULL (so the worker sends again),
 *   - delete its scorecard_corrective_action_tokens (prior-cycle links must not survive a new cycle — the
 *     worker's per-recipient reuse-skip would otherwise treat a surviving token as "already delivered THIS
 *     cycle" and skip re-sending, stranding the new responder), and
 *   - enqueue a scorecard_corrective_action_email job whose payload mirrors the reconcile enqueue EXACTLY
 *     (jobType SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB, { tenantSchema, scorecardId, dealId, officeId, cycleNonce }
 *     with a fresh per-cycle nonce, run_after ~120s, max_attempts 6, matching office_id + status).
 *
 * Runs in the caller's tenant transaction (the team-mutation PATCH/DELETE route commits both together), so the
 * revoke + re-notify is atomic with the team change.
 */
export async function restartCorrectiveActionNotificationCycleForDeal(
  tx: TenantDb,
  input: { dealId: string; office: { id: string; slug: string } },
): Promise<void> {
  const openScorecards = await tx
    .select({ id: fieldScorecards.id, dealId: fieldScorecards.dealId })
    .from(fieldScorecards)
    .where(
      and(
        eq(fieldScorecards.dealId, input.dealId),
        eq(fieldScorecards.status, "corrective_action_open"),
      ),
    );
  await restartCorrectiveActionCyclesForCards(tx, openScorecards, input.office);
}

/**
 * The same fresh-cycle restart, driven by a FIELD RESPONDER rather than a deal: every OPEN corrective-action
 * scorecard that PICKED this roster person for either role.
 *
 * Recipient resolution reads `field_responders` at send + verify time, so deactivating a picked person, moving
 * them between roles, or changing their email silently changes WHO answers a card — and, for the outstanding
 * link, revokes it (the token's email no longer matches a resolved recipient, so the next click 403s). Without
 * this the card is left unanswerable: the previous holder is locked out, the fallback deal-team super/PM was
 * never emailed, and `corrective_action_email_sent_at` suppresses any further send. This is the roster's
 * counterpart to the restart every deal_team_members mutation already performs, and it runs in the director's
 * own PATCH transaction so the roster edit and the re-notify commit together.
 *
 * A NAME edit deliberately does NOT come through here: it changes the display label, not who is reached or how
 * (the worker's recipient signature excludes `name` for the same reason).
 */
export async function restartCorrectiveActionNotificationCycleForResponder(
  tx: TenantDb,
  input: { responderId: string; office: { id: string; slug: string } },
): Promise<void> {
  const openScorecards = await tx
    .select({ id: fieldScorecards.id, dealId: fieldScorecards.dealId })
    .from(fieldScorecards)
    .where(
      and(
        eq(fieldScorecards.status, "corrective_action_open"),
        or(
          eq(fieldScorecards.superintendentResponderId, input.responderId),
          eq(fieldScorecards.pmResponderId, input.responderId),
        ),
      ),
    );
  await restartCorrectiveActionCyclesForCards(tx, openScorecards, input.office);
}

/**
 * Start a fresh notification cycle for an explicit set of open corrective-action cards. Shared by the deal- and
 * responder-scoped entry points above so the two can never drift on the nonce/token/enqueue trio, which the
 * worker's delivery stamp depends on being applied together.
 */
async function restartCorrectiveActionCyclesForCards(
  tx: TenantDb,
  openScorecards: Array<{ id: string; dealId: string }>,
  office: { id: string; slug: string },
): Promise<void> {
  if (openScorecards.length === 0) return;
  const input = { office };
  const dealIdByScorecardId = new Map(openScorecards.map((s) => [s.id, s.dealId]));

  const scorecardIds = openScorecards.map((s) => s.id);

  // Mint one fresh per-cycle nonce per open scorecard and use it in BOTH the persisted
  // corrective_action_cycle_nonce (the ACTIVE cycle) and that scorecard's enqueued job payload, so they stay
  // equal. This is what lets the worker's delivery stamp require `corrective_action_cycle_nonce =
  // payload.cycleNonce` — an in-flight stale-cycle job for this scorecard (its nonce no longer matches the one
  // stamped here) updates 0 rows and does NOT stamp, so THIS restart's matching-nonce job is the one that
  // stamps. The external signature is unchanged; the nonce is minted internally per scorecard.
  const cycleNonceByScorecardId = new Map(scorecardIds.map((id) => [id, randomUUID()]));

  // Clear the sent stamp (so the worker re-sends this cycle) AND stamp each scorecard's new ACTIVE cycle
  // nonce. Per-row because the nonce differs per scorecard (a single bulk update can't set per-row values).
  const now = new Date();
  for (const scorecardId of scorecardIds) {
    await tx
      .update(fieldScorecards)
      .set({
        correctiveActionEmailSentAt: null,
        correctiveActionCycleNonce: cycleNonceByScorecardId.get(scorecardId)!,
        updatedAt: now,
        // The OVERSIGHT stamps are deliberately NOT cleared here. This helper only ever touches scorecards
        // already at status 'corrective_action_open' (see the id query above): the corrective action never
        // left open, so from oversight's point of view nothing new happened — a responder was reassigned.
        // Oversight was correctly told once when it opened and will be told once when it completes.
        // Clearing them would re-send the "opened" notice on every team-tab reassignment, which is exactly
        // the inbox noise this feature is meant to avoid. A genuine REOPEN goes through
        // reconcileScorecardCorrectiveActions' transitioningIntoOpen branch, which does clear them.
      })
      .where(eq(fieldScorecards.id, scorecardId));
  }

  // Drop prior-cycle tokens on these scorecards (see the reuse-skip rationale above).
  await tx
    .delete(scorecardCorrectiveActionTokens)
    .where(inArray(scorecardCorrectiveActionTokens.scorecardId, scorecardIds));

  // Enqueue one fresh notification job per open scorecard — payload shape identical to the reconcile enqueue,
  // carrying the SAME per-scorecard nonce persisted above.
  await tx.insert(jobQueue).values(
    scorecardIds.map((scorecardId) => ({
      jobType: SCORECARD_CORRECTIVE_ACTION_EMAIL_JOB,
      payload: {
        tenantSchema: `office_${input.office.slug}`,
        scorecardId,
        // Per CARD, not per call: the responder-scoped restart can span several deals at once.
        dealId: dealIdByScorecardId.get(scorecardId)!,
        officeId: input.office.id,
        cycleNonce: cycleNonceByScorecardId.get(scorecardId)!,
      },
      officeId: input.office.id,
      status: "pending" as const,
      runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
      maxAttempts: 6,
    })),
  );
}
