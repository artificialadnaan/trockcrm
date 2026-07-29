import { useEffect, useState } from "react";
import { MIN_SEARCH_LENGTH, SEARCH_DEBOUNCE_MS, effectiveSearchQuery } from "../search-query";

/**
 * The search term to QUERY with, settled after the typing stops.
 *
 * Wraps `effectiveSearchQuery` in a timer and nothing else — the decision about what counts as a query
 * lives in that pure function so it can be tested without a renderer, which is this suite's convention.
 *
 * TWO THINGS THAT LOOK OPTIONAL AND ARE NOT:
 *
 * The timer is cleared on every change AND on unmount. Without the unmount clear, leaving the screen
 * mid-type fires a setState into a component that is gone — the warning is harmless, the habit is not,
 * and this app has already shipped one timer that outlived its screen (see the contact-search cleanup
 * in prospect.tsx).
 *
 * A query that lands back on its current value applies IMMEDIATELY rather than after another delay.
 * Clearing the box is the case that matters: a rep who wipes the field expects the full list back at
 * once, and making them wait 300ms for a state they can already see is the lag the debounce exists to
 * avoid. It also means the first render never waits.
 */
export function useDebouncedSearch(
  raw: string,
  { minLength = MIN_SEARCH_LENGTH, delayMs = SEARCH_DEBOUNCE_MS } = {},
): string {
  const target = effectiveSearchQuery(raw, minLength);
  const [settled, setSettled] = useState(target);

  useEffect(() => {
    if (target === settled) return;
    const timer = setTimeout(() => setSettled(target), delayMs);
    return () => clearTimeout(timer);
  }, [target, settled, delayMs]);

  return settled;
}
