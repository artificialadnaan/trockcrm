import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  deserializeFilters,
  mergeFilterParams,
  clearFilterParams,
  type FilterBarValue,
} from "./filterbar-params";
import { withResolvedDateWindow } from "./filterbar-date";

export interface UseFilterStateResult {
  filters: FilterBarValue;
  setFilters: (patch: Partial<FilterBarValue>) => void;
  /** Clear the FilterBar params. `preserveKeys` keeps the listed params (e.g. a page-owned `scope`
   *  that the surface inherits rather than renders). */
  resetFilters: (preserveKeys?: readonly string[]) => void;
}

/**
 * URL-backed FilterBar state. The URL is the source of truth (shareable, back-button-safe).
 * Patches preserve non-FilterBar params on the URL and page-reset on any non-page change.
 *
 * `prefix` namespaces this surface's params (default "" = bare). A list that shares a URL with a
 * board that has its own controls (e.g. the leads list under the leads board) passes a prefix so its
 * filters don't collide with the board's bare params (Codex #577).
 */
export function useFilterState(prefix = ""): UseFilterStateResult {
  const [searchParams, setSearchParams] = useSearchParams();
  // Re-resolve named date presets on read so a relative preset (e.g. "last 30 days") stays current
  // across reloads/bookmarks rather than freezing at the URL's stored bounds.
  const filters = useMemo(
    () => withResolvedDateWindow(deserializeFilters(searchParams, prefix)),
    [searchParams, prefix]
  );

  const setFilters = useCallback(
    (patch: Partial<FilterBarValue>) => {
      setSearchParams((prev) => mergeFilterParams(prev, patch, undefined, prefix), { replace: true });
    },
    [setSearchParams, prefix]
  );

  const resetFilters = useCallback(
    (preserveKeys: readonly string[] = []) => {
      setSearchParams((prev) => clearFilterParams(prev, preserveKeys, prefix), { replace: true });
    },
    [setSearchParams, prefix]
  );

  return { filters, setFilters, resetFilters };
}
