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
 * CLEARING APPLIES IMMEDIATELY. The debounce exists to stop a request per keystroke while a term is
 * being typed; an empty target sends no term at all, so there is nothing to protect. Waiting 300ms to
 * drop a filter meant a rep who wiped the field kept reading results for a query the box no longer
 * showed — the stale-filter behaviour this hook's own comment claims it prevents, arriving late instead
 * of never. Shortening "bishop" to "b" is the same case: the effective target is "" and the list should
 * stop pretending to be filtered while the hint explains why.
 *
 * The first render never waits either, since `settled` starts at the target.
 */
export function useDebouncedSearch(
  raw: string,
  { minLength = MIN_SEARCH_LENGTH, delayMs = SEARCH_DEBOUNCE_MS } = {},
): string {
  const target = effectiveSearchQuery(raw, minLength);
  const [settled, setSettled] = useState(target);

  useEffect(() => {
    if (target === settled) return;
    // Dropping a filter is not a request and does not need protecting from one.
    if (target === "") {
      setSettled("");
      return;
    }
    const timer = setTimeout(() => setSettled(target), delayMs);
    return () => clearTimeout(timer);
  }, [target, settled, delayMs]);

  return settled;
}
