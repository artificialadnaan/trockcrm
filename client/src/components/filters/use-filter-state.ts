import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  deserializeFilters,
  mergeFilterParams,
  clearFilterParams,
  type FilterBarValue,
} from "./filterbar-params";

export interface UseFilterStateResult {
  filters: FilterBarValue;
  setFilters: (patch: Partial<FilterBarValue>) => void;
  resetFilters: () => void;
}

/**
 * URL-backed FilterBar state. The URL is the source of truth (shareable, back-button-safe).
 * Patches preserve non-FilterBar params on the URL and page-reset on any non-page change.
 */
export function useFilterState(): UseFilterStateResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => deserializeFilters(searchParams), [searchParams]);

  const setFilters = useCallback(
    (patch: Partial<FilterBarValue>) => {
      setSearchParams((prev) => mergeFilterParams(prev, patch), { replace: true });
    },
    [setSearchParams]
  );

  const resetFilters = useCallback(() => {
    setSearchParams((prev) => clearFilterParams(prev), { replace: true });
  }, [setSearchParams]);

  return { filters, setFilters, resetFilters };
}
