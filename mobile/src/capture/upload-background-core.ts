export type BackgroundUploadOwner = { ownerKey: string; officeId: string | null };

/**
 * Drain every registered owner namespace even when one is corrupt, inaccessible, or temporarily failing.
 * The OS still receives a failed task result after all queues get their chance, using the first failure as
 * the representative cause rather than letting one stale office starve every later namespace.
 */
export async function drainBackgroundOwnerQueues(
  owners: readonly BackgroundUploadOwner[],
  operations: {
    /** Count of rows a drain should be SCHEDULED for — drainable OR a mid-enqueue `staging` row that the
     *  drain's own reconciliation will unstick. MUST include staging rows (getSchedulableCount, not
     *  getQueuedCount): a lone interrupted capture is 0 drainable but still needs a drain to reconcile +
     *  ship it, and gating on drainable-only would skip that owner forever. */
    getSchedulableCount: (ownerKey: string) => Promise<number>;
    drainOwner: (owner: BackgroundUploadOwner) => Promise<unknown>;
  },
): Promise<void> {
  let firstError: unknown;
  let hasError = false;
  for (const owner of owners) {
    try {
      if ((await operations.getSchedulableCount(owner.ownerKey)) === 0) continue;
      await operations.drainOwner(owner);
    } catch (error) {
      if (!hasError) {
        hasError = true;
        firstError = error;
      }
    }
  }
  if (hasError) throw firstError;
}
