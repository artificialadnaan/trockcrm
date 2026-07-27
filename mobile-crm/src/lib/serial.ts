/**
 * Runs async operations one at a time, in the order they were submitted.
 *
 * Two places need exactly this, for the same underlying reason — an operation that reads shared state
 * must not start until the previous one has finished writing it:
 *
 *   SecureStore mutations — a sign-out's pending delete landing after a new account's save removes that
 *   account's stored session.
 *
 *   Session revalidation — two overlapping /auth/me calls both capture the same session object, the
 *   first response to land replaces it, and the second is then discarded by its own identity check
 *   *even though it is newer*. Serialising makes the newest invocation the last to run, and lets each
 *   one re-read current state when its turn arrives.
 *
 * A rejected operation must not break the chain: the internal chain always continues, while the promise
 * returned to the caller still rejects so callers that care can react.
 */
export function createSerialRunner() {
  let chain: Promise<unknown> = Promise.resolve();

  return function run<T>(op: () => Promise<T>): Promise<T> {
    const result = chain.then(op, op);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
