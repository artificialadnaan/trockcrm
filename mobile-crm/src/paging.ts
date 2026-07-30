/**
 * When an infinite list may ask for its next page.
 *
 * `onEndReached` fires on every scroll that reaches the tail, so the condition guarding it is the only
 * thing standing between one request and a request per frame. Two of the three clauses are obvious;
 * the third is the one that was missing.
 *
 * When a page FAILS, TanStack keeps `hasNextPage` true — the cursor is still there, the page just did
 * not arrive — and clears `isFetchingNextPage`, because nothing is in flight. Both of the obvious
 * clauses therefore pass, and the very next scroll event re-fires against an endpoint that has just
 * errored. The list hammers it, silently, for as long as the user keeps moving; nothing on screen says
 * so, and the only visible recovery was a pull-to-refresh that reloads page one instead of retrying the
 * page that failed.
 *
 * So a failed page stops the automatic path and hands the decision back: the footer says it failed and
 * retries on tap. A retry a user asked for is worth any number of retries they did not.
 *
 * Shared and pure because both directories and the task list express the same rule, and every time this
 * app has expressed one rule three times, one copy has been wrong.
 */
export function shouldLoadNextPage(query: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
}): boolean {
  return query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError;
}
