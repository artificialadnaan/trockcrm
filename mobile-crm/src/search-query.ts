/**
 * What a typed search box should actually ASK THE SERVER for.
 *
 * All three lists had the same shape: type, press return, wait. Every one of the pieces was defensible
 * — a two-character floor stops a one-letter query dragging back half the office, and an explicit
 * submit stops a request per keystroke — and together they made the app feel like it needed permission
 * before it would look anything up. A rep hunting a building between meetings pays that tax on every
 * screen.
 *
 * So the floor stays and the CEREMONY goes. Debouncing buys back what the submit button was protecting:
 * one request per pause, not one per keystroke.
 */

/** Below this, a query matches too much to be worth sending. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * Long enough that ordinary typing produces one request, short enough to feel immediate.
 *
 * 300ms is roughly the gap between words rather than between letters, so a rep typing "bishop" sends
 * one query instead of six. Below ~200ms fast typists still fan out; above ~500ms it reads as lag.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The query string for a raw input — `""` meaning "no filter", never a partial one.
 *
 * A one-character input is treated exactly like an empty one, which is what the submit guard already
 * did; the difference is that the screen now says so with a hint instead of silently refusing to act.
 * Deliberately NOT "keep the previous query": holding a stale filter while the box shows something else
 * is the two-paths-disagreeing shape this codebase keeps getting caught by.
 */
export function effectiveSearchQuery(raw: string, minLength: number = MIN_SEARCH_LENGTH): string {
  const trimmed = raw.trim();
  return trimmed.length >= minLength ? trimmed : "";
}

/**
 * Should the screen explain why nothing is filtering yet?
 *
 * Only for a genuinely too-short entry. An empty box is not a mistake and must not be nagged at.
 */
export function searchIsTooShort(raw: string, minLength: number = MIN_SEARCH_LENGTH): boolean {
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length < minLength;
}
