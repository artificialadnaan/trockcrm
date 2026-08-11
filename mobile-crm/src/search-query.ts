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

/**
 * SPLIT a result set into what this app can open and what it merely found.
 *
 * `/search` is cross-office for an admin or director: the server searches every accessible office and
 * stamps each hit with its `officeSlug` (search/service.ts:302). Every OTHER request this app makes
 * carries the active office's `x-office-id`, and offices are separate Postgres schemas — so following a
 * hit from elsewhere asks the wrong schema for that id and gets a 404. The app cannot switch to it
 * either; office switching is not built yet.
 *
 * So a record that cannot be opened is not offered as a row. It is COUNTED instead, because silently
 * dropping matches is how a search box teaches someone it does not have their data.
 *
 * THE UNKNOWN-OFFICE CASE IS THE SUBTLE ONE. `/auth/accessible-offices` is a cached side-request; it can
 * still be in flight, and it is allowed to fail without taking a screen down. My first version passed
 * everything through when the active office was unknown, reasoning that filtering on nothing would empty
 * the screen. That is right for a single-office rep and wrong for the exact user this filter exists for:
 * a director's response IS office-stamped, so "pass everything" re-admits every cross-office row —
 * unopenable, and able to collide on id with a row from another office in the same list.
 *
 * The stamp itself resolves it. A hit carrying an `officeSlug` came from a cross-office search, and with
 * no active slug to compare it against there is no way to know whether it is reachable — so it is
 * counted, not shown. A hit with NO stamp came from a single-office search, which by construction ran in
 * the active office, and stays. Neither case guesses.
 */
export function partitionByOffice<T extends { officeSlug?: string }>(
  hits: readonly T[],
  activeOfficeSlug: string | null
): { openable: T[]; elsewhere: number } {
  const openable: T[] = [];
  let elsewhere = 0;
  for (const hit of hits) {
    // No stamp → a single-office search, which ran in the active office by construction.
    // Stamped and matching → ours. Stamped with no active slug to check → unknowable, so not offered.
    if (!hit.officeSlug || hit.officeSlug === activeOfficeSlug) openable.push(hit);
    else elsewhere += 1;
  }
  return { openable, elsewhere };
}

/**
 * The server's result order, PRESERVED — not re-derived from rank alone.
 *
 * Search keeps won, lost and on-hold deals findable but SECONDARY: `compareHits` puts active work
 * first, then on-hold, then terminal, and only compares relevance inside a tier. Re-sorting the merged
 * list by `rank` on the client threw that contract away, so an exact-name match on a deal lost last
 * quarter outranked a weaker match on the one closing this week — closed work at the top of a search a
 * rep runs to find live work.
 *
 * Mirrors the server's tiers deliberately, including won and lost sharing one: the distinction between
 * them is a fact about the deal, not a claim about which is more worth your attention now.
 *
 * Non-deals carry no status and sit in the active tier, which is right — a contact is not "closed".
 */
const STATUS_TIER: Record<string, number> = { active: 0, on_hold: 1, won: 2, lost: 2 };

export function compareSearchHits(
  a: { status?: string; rank: number },
  b: { status?: string; rank: number }
): number {
  const tierA = STATUS_TIER[a.status ?? "active"] ?? 0;
  const tierB = STATUS_TIER[b.status ?? "active"] ?? 0;
  if (tierA !== tierB) return tierA - tierB;
  return b.rank - a.rank;
}
