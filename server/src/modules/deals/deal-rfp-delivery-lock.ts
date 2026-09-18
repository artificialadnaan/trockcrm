import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Transaction-scoped serialization point for "may this deal's queued RFP work still be sent right now".
 *
 * WHY IT EXISTS. Clearing the RFP columns is not enough to stop an ORPHAN outbound submission: the
 * delivery worker authorizes a send from its own read of the deal, and an unlocked read can observe
 * `pending_outbox` a microsecond before "Move back to Opportunity" commits and POST anyway. Both sides
 * take this lock so they serialize: either the worker authorizes and the move-back waits, or the
 * move-back commits first and the worker reads the cleared cycle and declines.
 *
 * LOCK ORDER — THE PART THAT IS LOAD-BEARING. This lock MUST be taken BEFORE any row lock, as the very
 * first work of the transaction, next to `lockDealCommissions`. The worker takes it first in ITS
 * transaction and then reads the deal row; if the move-back took it in the other order — deal row
 * `FOR UPDATE` first, this lock second — the two transactions would each hold what the other needs.
 *
 * That is not a theoretical tidiness point, and it is worth being precise about the current wait graph:
 * the delivery worker's pre-send read is a PLAIN `SELECT` with no `FOR UPDATE`, so under MVCC it does
 * not block on the move-back's row lock, and a two-party cycle is not constructible TODAY. What makes
 * the inverted order unacceptable anyway is how little it takes to close the cycle — adding `FOR UPDATE`
 * to that preflight, or having any future locked pre-send protocol (the Bid Board create worker now has
 * one) take a row lock while holding this, closes it immediately. And the failure would be silent
 * rather than loud: both workers' prefligh rechecks fail OPEN by design, so a deadlock abort inside the
 * recheck is swallowed and the worker sends the stale request anyway — the exact orphan this lock
 * exists to prevent, reintroduced by the mechanism meant to prevent it.
 *
 * So the ordering rule is: **advisory locks first (commission, then delivery), row locks after.** Both
 * are keyed per deal, both are transaction-scoped, and only the move-back holds both — the recompute
 * takes only the commission lock and the RFP workers take only this one — so the relative order of the
 * two advisory locks cannot itself deadlock. It is fixed here regardless, so the rule stays checkable.
 *
 * Transaction-scoped (`pg_advisory_xact_lock`), released by COMMIT/ROLLBACK, cannot leak on an error
 * path. `hashtext` over a namespaced string matches the SyncHub webhook's convention; a hash collision
 * costs a spurious wait, never a correctness bug.
 *
 * The namespace string is duplicated in `worker/src/jobs/rfp-request-delivery.ts`
 * (DEAL_RFP_DELIVERY_LOCK_NAMESPACE) because server and worker are separate packages. The two MUST stay
 * identical — they are the same lock.
 */
export const DEAL_RFP_DELIVERY_LOCK_NAMESPACE = "deal_rfp_delivery:";

export async function lockDealRfpDelivery(tenantDb: TenantDb, dealId: string): Promise<void> {
  await tenantDb.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${DEAL_RFP_DELIVERY_LOCK_NAMESPACE}${dealId}`}))`
  );
}
