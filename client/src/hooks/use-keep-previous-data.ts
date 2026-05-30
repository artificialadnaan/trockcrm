import { useEffect, useRef } from "react";

export interface KeepPreviousDataResult<T> {
  /**
   * The current value, or -- ONLY while a refetch is in flight -- the most recent
   * non-nullish value. Once a fetch has settled, the real result (including a
   * legitimate nullish "not found / cleared / empty") is returned, never stale data.
   */
  data: T;
  /** True only before the FIRST fetch has settled -- the one time it is OK to show a full skeleton. */
  isInitialLoading: boolean;
  /** True when a refetch is in flight after the first load -- keep rendering `data`, show a subtle "updating" affordance. */
  isRefreshing: boolean;
  /** True when `data` is currently non-nullish (useful for empty-state decisions). */
  hasData: boolean;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * "Keep previous data during background refetch" primitive (PR 1 of the no-blank UX
 * work). Wraps a hand-rolled `{ data, loading }` hook so a dependency change (date
 * pinch, search keystroke) does NOT blank the page: prior data stays visible WHILE the
 * refetch is in flight, then the real result takes over once it settles. Modeled on the
 * Reports page's well-behaved (never-blank) behavior, generalized for any page.
 *
 * Not wired into any page yet. Adoption is a 2-line change per page:
 *
 *   const { data: raw, loading } = useSomeListHook(filters);
 *   const { data, isInitialLoading, isRefreshing } = useKeepPreviousData(raw, loading);
 *   if (isInitialLoading) return <Skeleton />;   // was: if (loading) ...
 *   // render `data`; optionally show a spinner when isRefreshing
 *
 * Semantics (deliberately narrow, so it is never wrong):
 *   - Previous value is retained ONLY while loading -- a SETTLED nullish/empty result is
 *     shown as-is (no stale record/list after "not found", "cleared", or "no matches").
 *   - isInitialLoading is gated on whether a fetch has settled yet, NOT on data presence,
 *     so a hook seeded with an initial [] / null placeholder still shows the first skeleton
 *     instead of flashing an empty state.
 *   - Handles hooks that keep their data during a refetch AND hooks that null it.
 */
export function useKeepPreviousData<T>(value: T, loading: boolean): KeepPreviousDataResult<T> {
  const lastNonNullRef = useRef<T>(value);
  const hasSettledRef = useRef(false);

  useEffect(() => {
    if (!isNullish(value)) {
      lastNonNullRef.current = value;
    }
  }, [value]);

  useEffect(() => {
    if (!loading) {
      hasSettledRef.current = true;
    }
  }, [loading]);

  const data = isNullish(value) && loading ? lastNonNullRef.current : value;
  const hasData = !isNullish(data);
  const isInitialLoading = loading && !hasSettledRef.current;
  const isRefreshing = loading && hasSettledRef.current;

  return { data, isInitialLoading, isRefreshing, hasData };
}
