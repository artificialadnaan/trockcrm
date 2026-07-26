/**
 * Serialises SecureStore mutations and drops the ones a newer identity change has superseded.
 *
 * Two problems, one mechanism:
 *
 *   ORDERING — sign-out publishes `null` immediately so the router can show login. Its keychain delete
 *   is still pending. A new account signs in and saves. If those two writes are not serialised, the
 *   delete can land AFTER the save and remove the new account's stored session. The app stays
 *   authenticated in memory, so nothing looks wrong until the next launch signs them out.
 *
 *   SUPERSESSION — even serialised, an operation belonging to a previous identity must not run at all.
 *   Each is tagged with the auth generation it was issued under; if the generation has moved on by the
 *   time its turn arrives, it is skipped.
 *
 * `currentGeneration` is read at EXECUTION time, not at enqueue time. That is the whole point: the
 * decision has to reflect what has happened while the operation sat in the queue.
 */
export function createPersistQueue(currentGeneration: () => number) {
  let chain: Promise<unknown> = Promise.resolve();

  return function enqueue(generation: number, op: () => Promise<void>): Promise<void> {
    const run = chain.then(() => {
      if (generation !== currentGeneration()) return undefined;
      return op();
    });
    // The chain must survive a rejection or every later write would be skipped for the life of the app.
    // `run` itself still rejects, so callers that care — signIn does — can react to a failed write.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => undefined);
  };
}
