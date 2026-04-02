import { useState, useCallback, useEffect } from "react";
import type { ContactFilters } from "./use-contacts";

const STORAGE_KEY = "trock-crm-contact-filters";

function loadFilters(): ContactFilters {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore parse errors */ }
  return { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
}

function saveFilters(filters: ContactFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch { /* ignore quota errors */ }
}

export function useContactFilters() {
  const [filters, setFiltersState] = useState<ContactFilters>(loadFilters);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const setFilters = useCallback((update: Partial<ContactFilters>) => {
    setFiltersState((prev) => {
      const resetPage = update.page === undefined;
      return { ...prev, ...update, ...(resetPage ? { page: 1 } : {}) };
    });
  }, []);

  const resetFilters = useCallback(() => {
    const defaults: ContactFilters = { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
    setFiltersState(defaults);
  }, []);

  return { filters, setFilters, resetFilters };
}
