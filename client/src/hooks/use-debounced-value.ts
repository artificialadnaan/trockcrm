import { useEffect, useState } from "react";

/**
 * Shared debounce delay for search inputs across the app. Matches the existing
 * use-search.ts DEBOUNCE_MS so every search surface settles on the same cadence.
 */
export const DEFAULT_SEARCH_DEBOUNCE_MS = 300;

/**
 * Returns `value` only after it has stopped changing for `delayMs`. Use this to
 * separate the fast, smooth typing/clicking state (the raw value) from the slow,
 * server-keyed query value, so a keystroke or filter change does NOT immediately
 * trigger a refetch.
 *
 * Foundational primitive (PR 1 of the no-blank UX work). Not wired into any page
 * yet -- pages adopt it incrementally:
 *
 *   const [text, setText] = useState("");
 *   const query = useDebouncedValue(text, 300); // feed `query` to the data hook
 *
 * Pass `delayMs <= 0` to disable debouncing (value passes through immediately) --
 * useful for tests or callers that want an opt-out without branching at the call site.
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number = DEFAULT_SEARCH_DEBOUNCE_MS
): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
