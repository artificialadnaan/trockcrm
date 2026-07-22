import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { fieldScorecards, scorecardCorrectiveActions } from "@trock-crm/shared/schema";

// Matches the alias the field scorecard services use (scorecards-service.ts): the per-office tenant db.
type TenantDb = NodePgDatabase<typeof schema>;

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
