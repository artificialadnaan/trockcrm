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
 * app has expressed one rule three times, one copy has been wrong. That is not hypothetical here: the
 * contacts list shipped without the failure clause that the deals list had carried from the start.
 *
 * NOT yet the only expression of it. The deals, contacts and stage lists reach the same conclusion
 * through their own `listState.pageFailed` state machines, which carry more than this predicate knows
 * about. Folding them in means touching those machines and their tests, so it is deliberately left
 * alone rather than half-done — but they are the places to check first if this rule ever changes.
 */
export function shouldLoadNextPage(query: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
}): boolean {
  return query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError;
}

/**
 * Did a REFRESH fail — as distinct from a page failing?
 *
 * `isError` conflates the two. When page 3 fails, TanStack keeps the loaded pages and sets `isError`
 * AND `isFetchNextPageError`, so a header derived from `data && isError` announced "the refresh
 * failed" at the top of a list nobody had refreshed, at the same moment the footer correctly said
 * loading more had failed. Two messages, one failure, and only one of them true.
 *
 * The distinction matters because the two failures have different recoveries: a refresh retries with
 * `refetch()` and reloads page one, a failed page retries with `fetchNextPage()` and fills the gap.
 * Offering the wrong one silently drops the rows the user was actually reaching for.
 *
 * Deliberately not `isRefetchError`: that is false during the very first load, but this predicate is
 * only ever consulted with data already on screen, and excluding the next-page case by name keeps the
 * reason legible at the call site.
 */
export function refreshFailed(query: {
  data: unknown;
  isError: boolean;
  isFetchNextPageError: boolean;
}): boolean {
  return Boolean(query.data) && query.isError && !query.isFetchNextPageError;
}
