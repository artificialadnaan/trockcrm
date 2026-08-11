/**
 * The sentence to SHOW a person for something that was thrown.
 *
 * `String(error)` on an `Error` yields "Error: <message>", and that prefix is noise on every surface
 * this app has: the walk screen's unqueued banner, Profile's failed-walk and recovery cards, the
 * walk recorder's own error text. Several of those messages are written as user-facing prose in the
 * first place — `enqueueRecoveredWalk` throws "That walk is still recording — end it before filing
 * it." precisely so the card can render it — and the ones that are not (a filesystem "No space left
 * on device") are still read for the one clause the estimator can act on. "Error:" helps with
 * neither.
 *
 * Shared rather than repeated because the four call sites had already drifted: useWalk carried this
 * exact function while three screens called `String(error)` next to comments claiming they showed
 * the message verbatim.
 *
 * An EMPTY message falls back to `String(err)` deliberately. `new Error()` stringifies to "Error",
 * which says nothing but is still a sign of life; rendering "" would leave a banner whose whole
 * point is to explain something showing nothing at all.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}
