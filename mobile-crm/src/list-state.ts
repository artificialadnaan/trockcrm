/**
 * Which state should a paginated list screen render?
 *
 * This decision has been got wrong FOUR times in this app, each time in a slightly different place, and
 * every time the failure looked like success:
 *
 *   - a failed refresh replaced a list the user was reading with a full-screen error;
 *   - a successfully-loaded EMPTY result was treated as "never loaded", so a failed refresh replaced the
 *     real empty state with a blocking error;
 *   - the inline retry was gated on row count, so an empty result reported a failed refresh NOWHERE;
 *   - and a failed refresh rendered only in the footer, off-screen below a full page, so the refresh
 *     appeared to succeed while stale data stayed up.
 *
 * The distinctions that actually matter, none of which are "how many rows are there":
 *
 *   NEVER LOADED   (`data === undefined`) — nothing to show, so an error here blocks the screen.
 *   LOADED, EMPTY  — a real, meaningful answer. Reps see only their own deals on a contact, so this is
 *                    often the CORRECT state, not an edge case. It must stay refreshable.
 *   LOADED, ERROR  — keep what is on screen and say the refresh failed, near whichever gesture failed.
 *
 * Pure and exhaustive so it can be tested, because the screens themselves are not.
 */
export type ListState =
  | { kind: "loading" }
  /** Nothing ever loaded and the request failed — the only case that may take over the screen. */
  | { kind: "blocking-error" }
  /**
   * Data loaded — including a loaded result of zero rows, which is an answer rather than an absence.
   * The screens render that case through FlatList's own ListEmptyComponent, so this deliberately does
   * NOT restate it as a field: an unconsumed flag looks load-bearing and tested when it is neither.
   */
  | {
      kind: "loaded";
      /** A failed refresh/revalidate. Belongs at the TOP, next to the pull gesture. */
      refreshFailed: boolean;
      /** A failed load-more. Belongs in the FOOTER, where the user is when it happens. */
      pageFailed: boolean;
    };

export function resolveListState(input: {
  isLoading: boolean;
  /** `undefined` means no request has ever succeeded. An empty array is a successful load. */
  data: unknown;
  error: unknown;
  isFetchNextPageError: boolean;
}): ListState {
  const { isLoading, data, error, isFetchNextPageError } = input;
  if (isLoading) return { kind: "loading" };

  // `data === undefined`, never rowCount: "loaded, and empty" is not "never loaded".
  const everLoaded = data !== undefined;
  if (error && !everLoaded) return { kind: "blocking-error" };

  return {
    kind: "loaded",
    // Both are independent of rowCount — an empty list can fail to refresh just as a full one can, and
    // that failure has to be reported somewhere.
    refreshFailed: Boolean(error) && !isFetchNextPageError,
    pageFailed: Boolean(error) && isFetchNextPageError,
  };
}
