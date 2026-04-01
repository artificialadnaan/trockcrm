import { useState, useCallback, useEffect } from "react";
import type { DealFilters } from "./use-deals";

const STORAGE_KEY = "trock-crm-deal-filters";

function loadFilters(): DealFilters {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore parse errors */ }
  return { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
}

function saveFilters(filters: DealFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch { /* ignore quota errors */ }
}

export function useDealFilters() {
  const [filters, setFiltersState] = useState<DealFilters>(loadFilters);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const setFilters = useCallback((update: Partial<DealFilters>) => {
    setFiltersState((prev) => {
      // Reset page to 1 when filters change (except when explicitly setting page)
      const resetPage = update.page === undefined;
      return { ...prev, ...update, ...(resetPage ? { page: 1 } : {}) };
    });
  }, []);

  const resetFilters = useCallback(() => {
    const defaults: DealFilters = { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
    setFiltersState(defaults);
  }, []);

  return { filters, setFilters, resetFilters };
}
