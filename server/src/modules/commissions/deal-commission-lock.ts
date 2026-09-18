import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Transaction-scoped serialization point for "who may change this deal's commission rows right now".
 *
 * WHY IT EXISTS. Almost every commission writer is already serialized by the deal ROW: the contract-date
 * transition (setDealContractSignedDate), the estimator setter, the sales-source setter and the
 * change-order paths all UPDATE `deals` in the same transaction as the mint, so they take the row lock
 * that "Move back to Opportunity" holds with `FOR UPDATE`. And an UPDATE of an EXISTING commission row
 * is serialized by the move-back's `FOR UPDATE` on `deal_signed_commissions`.
 *
 * Exactly one path escapes both: the settings-driven cross-office recompute
 * (recalculateRepCommissionsInOffice) calls mintSalesSourceCommissionForDeal, which decides from an
 * UNLOCKED read of the deal — including its signed date — and then INSERTs a brand-new row without ever
 * writing `deals`. Its INSERT does block on the FK's `FOR KEY SHARE` against our `FOR UPDATE`, but it
 * resumes AFTER we commit and still acts on the stale decision, so a row can land on a deal we have just
 * returned to Opportunity and reported as having zero commission. Row locks cannot stop that: preventing
 * a phantom INSERT needs either SERIALIZABLE or cooperation from the writer.
 *
 * LOCK ORDER — the reason this is safe. Both participants take this advisory lock BEFORE any row lock:
 * the move-back as the very first statement of its transaction, the recompute before it reads each deal.
 * The recompute's office transaction accumulates one lock per deal it touches and holds them to COMMIT,
 * so a move-back on any of those deals simply waits, holding nothing, until the recompute finishes.
 * Because the waiter holds no row locks while it waits, there is no cycle and therefore no deadlock.
 * Adding it anywhere AFTER a row lock would create one, which is why both call sites take it first.
 *
 * Transaction-scoped (`pg_advisory_xact_lock`), so it is released by COMMIT/ROLLBACK and cannot leak on
 * an error path. Keyed by hashtext over a namespaced string, matching the SyncHub webhook's existing
 * advisory-lock convention; a hash collision costs a spurious wait, never a correctness bug.
 */
export const DEAL_COMMISSION_LOCK_NAMESPACE = "deal_commission:";

export async function lockDealCommissions(tenantDb: TenantDb, dealId: string): Promise<void> {
  await tenantDb.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${DEAL_COMMISSION_LOCK_NAMESPACE}${dealId}`}))`
  );
}
