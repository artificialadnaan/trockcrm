import { createSerialRunner } from "../lib/serial";

/**
 * Serialises SecureStore mutations so an older write can never land on top of a newer one.
 *
 * Sign-out publishes `null` immediately so the router can show login, leaving its keychain delete
 * pending. A new account then signs in and saves. Without ordering, that delete can land AFTER the save
 * and remove the new account's stored session — the app stays authenticated in memory, so nothing looks
 * wrong until the next launch signs them out.
 *
 * SAVES and CLEARS are treated differently, and the asymmetry is the whole point:
 *
 *   save()  is SUPERSEDABLE. Writing an older session over a newer one is corruption, so a save whose
 *           generation has been overtaken is skipped.
 *
 *   clear() is NOT. FIFO ordering already guarantees that any save enqueued after it runs after it, so a
 *           clear can never clobber a newer session. Discarding it is what causes harm: if the
 *           replacement save then FAILS, the new account is never published AND the signed-out account's
 *           token is still on disk — so the next launch silently restores an account somebody explicitly
 *           signed out of. On the shared field devices this queue exists to protect, that is a
 *           credential exposure, and it is caused by the optimisation rather than prevented by it.
 *
 * `currentGeneration` is read at EXECUTION time, not enqueue time: the decision has to reflect what has
 * happened while the operation sat in the queue.
 */
export function createPersistQueue(currentGeneration: () => number) {
  // Ordering comes from the shared runner; this module adds only the supersession policy.
  const run = createSerialRunner();

  function enqueue(op: () => Promise<void>, shouldRun: () => boolean): Promise<void> {
    return run(async () => {
      if (shouldRun()) await op();
    });
  }

  return {
    /** Persist a session. Skipped if a newer sign-in or sign-out has taken over since it was queued. */
    save(generation: number, op: () => Promise<void>): Promise<void> {
      return enqueue(op, () => generation === currentGeneration());
    },
    /** Erase the stored session. ALWAYS runs — see the note above on why this must not be superseded. */
    clear(op: () => Promise<void>): Promise<void> {
      return enqueue(op, () => true);
    },
  };
}
