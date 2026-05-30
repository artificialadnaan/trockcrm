import { useEffect, useRef } from "react";

export interface KeepPreviousDataResult<T> {
  /**
   * The latest non-nullish value, falling back to the most recent one seen while a
   * refetch is in flight. Never goes blank once data has loaded.
   */
  data: T;
  /** True only on the FIRST load, before any data exists -- the one time it is OK to show a full skeleton. */
  isInitialLoading: boolean;
  /** True when a refetch is in flight but prior data exists -- keep rendering `data`, show a subtle "updating" affordance. */
  isRefreshing: boolean;
  /** True once any non-nullish data has been seen. */
  hasData: boolean;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * "Keep previous data during background refetch" primitive (PR 1 of the no-blank UX
 * work). Wraps a hand-rolled `{ data, loading }` hook so a dependency change (date
 * pinch, search keystroke) does NOT blank the page: prior data stays visible while
 * the refetch happens underneath. Modeled on the Reports page's well-behaved
 * (never-blank) behavior, generalized so any page can adopt it without rewriting its
 * fetch hook.
 *
 * Not wired into any page yet. Adoption is a 2-line change per page:
 *
 *   const { data: raw, loading } = useSomeListHook(filters);
 *   const { data, isInitialLoading, isRefreshing } = useKeepPreviousData(raw, loading);
 *   if (isInitialLoading) return <Skeleton />;   // was: if (loading) ...
 *   // render `data`; optionally show a spinner when isRefreshing
 *
 * Handles BOTH shapes seen in the codebase: hooks that keep their data during a
 * refetch (most) AND hooks that null it (e.g. on a stale-response path) -- in either
 * case the last good value is retained until fresh data arrives.
 */
export function useKeepPreviousData<T>(value: T, loading: boolean): KeepPreviousDataResult<T> {
  const lastNonNullRef = useRef<T>(value);

  useEffect(() => {
    if (!isNullish(value)) {
      lastNonNullRef.current = value;
    }
  }, [value]);

  const data = isNullish(value) ? lastNonNullRef.current : value;
  const hasData = !isNullish(data);

  return {
    data,
    isInitialLoading: loading && !hasData,
    isRefreshing: loading && hasData,
    hasData,
  };
}
