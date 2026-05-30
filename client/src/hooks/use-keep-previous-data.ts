import { useEffect, useRef } from "react";

export interface KeepPreviousDataResult<T> {
  /**
   * The current value, or -- ONLY while a refetch is in flight -- the most recent
   * non-nullish value. Once a fetch has settled, the real result (including a
   * legitimate nullish "not found / cleared / empty") is returned, never stale data.
   */
  data: T;
  /** True only before the FIRST successful fetch has settled -- the one time it is OK to show a full skeleton. */
  isInitialLoading: boolean;
  /** True when a refetch is in flight after the first successful load -- keep rendering `data`, show a subtle "updating" affordance. */
  isRefreshing: boolean;
  /** True when `data` is currently non-nullish (useful for empty-state decisions). */
  hasData: boolean;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * "Keep previous data during background refetch" primitive. Wraps a hand-rolled
 * `{ data, loading, error }` hook so a dependency change (date pinch, etc.) does NOT
 * blank the page: prior data stays visible WHILE the refetch is in flight, then the
 * real result takes over once it settles. Modeled on the Reports page's never-blank
 * behavior.
 *
 * Adoption is a 2-line change per page:
 *
 *   const { data: raw, loading, error } = useSomeHook(filters);
 *   const { data, isInitialLoading, isRefreshing } = useKeepPreviousData(raw, loading, error);
 *   if (isInitialLoading) return <Skeleton />;   // was: if (loading) ...
 *   // render `data`; optionally show a spinner when isRefreshing
 *
 * Semantics (deliberately narrow, so it is never wrong):
 *   - Previous value is retained ONLY while loading -- a SETTLED nullish/empty result is
 *     shown as-is (no stale record/list after "not found", "cleared", or "no matches").
 *   - "Settled" = a fetch COMPLETED WITHOUT ERROR. Pass the hook's `error` so the primitive
 *     can tell a successful empty/null completion (settles -> later refetch is a refresh,
 *     not a first load) from a FAILED completion (does NOT settle -> a retry after a failed
 *     initial load still shows the skeleton, never a blank). Without an explicit success
 *     signal, value alone cannot distinguish "loaded nothing" from "failed to load", which
 *     is exactly why `error` is threaded in rather than inferring from nullish data.
 *   - isInitialLoading is gated on whether a fetch has SUCCESSFULLY settled yet, NOT on data
 *     presence, so a hook seeded with an initial [] / null placeholder still shows the first
 *     skeleton instead of flashing an empty state.
 *   - Handles hooks that keep their data during a refetch AND hooks that null it.
 *
 * NOTE: for filters that map MANY-TO-ONE onto the fetch key (e.g. a coarse range where two
 * tabs fetch the same data, so toggling them does not refetch), a "rendered snapshot synced
 * to data arrival" gets stuck -- drive labels/links off the live value there, not this hook.
 */
export function useKeepPreviousData<T>(
  value: T,
  loading: boolean,
  error?: unknown
): KeepPreviousDataResult<T> {
  const lastNonNullRef = useRef<T>(value);
  const hasSettledRef = useRef(false);

  useEffect(() => {
    if (!isNullish(value)) {
      lastNonNullRef.current = value;
    }
  }, [value]);

  useEffect(() => {
    // A completion WITHOUT error settles (including a successful empty/null result); a
    // completion WITH error does not, so a retry after a failed first load keeps showing
    // the skeleton instead of blanking.
    if (!loading && !error) {
      hasSettledRef.current = true;
    }
  }, [loading, error]);

  const data = isNullish(value) && loading ? lastNonNullRef.current : value;
  const hasData = !isNullish(data);
  const isInitialLoading = loading && !hasSettledRef.current;
  const isRefreshing = loading && hasSettledRef.current;

  return { data, isInitialLoading, isRefreshing, hasData };
}
