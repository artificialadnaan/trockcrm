import { useState, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import type { ActivityFeedEntryRecord, ActivityFeedItemRecord } from "@/components/audit/activity-feed-entry";

export interface AuditLogFilter {
  entityType?: string;
  actorQuery?: string;
  action?: string;
  fromDate?: string;
  toDate?: string;
}

export function useAuditLog() {
  const [rows, setRows] = useState<ActivityFeedItemRecord[]>([]);
  const [total] = useState<number | null>(null);
  const [totalLoading] = useState(false);
  const [totalError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [cursorByPage, setCursorByPage] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AuditLogFilter>({});
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const currentCursor = cursorByPage[page];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (currentCursor) params.set("cursor", currentCursor);
      if (filter.entityType) params.set("entityType", filter.entityType);
      if (filter.actorQuery) params.set("actorQuery", filter.actorQuery);
      if (filter.action) params.set("action", filter.action);
      if (filter.fromDate) params.set("fromDate", filter.fromDate);
      if (filter.toDate) params.set("toDate", filter.toDate);

      const data = await api<{ rows: ActivityFeedItemRecord[]; hasMore: boolean; nextCursor?: string | null }>(
        `/admin/audit?${params}`
      );
      setRows(data.rows);
      setHasMore(data.hasMore);
      setCursorByPage((current) => {
        if (!data.nextCursor) {
          const { [page + 1]: _removed, ...rest } = current;
          return rest;
        }
        return { ...current, [page + 1]: data.nextCursor };
      });
    } finally {
      setLoading(false);
    }
  }, [page, currentCursor, filter]);

  const loadEntityTypes = useCallback(async () => {
    try {
      const data = await api<{ entityTypes: string[] }>("/admin/audit/entity-types");
      setEntityTypes(data.entityTypes);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadEntityTypes(); }, [loadEntityTypes]);

  const updateFilter = useCallback<Dispatch<SetStateAction<AuditLogFilter>>>((nextFilter) => {
    setPage(1);
    setCursorByPage({});
    setFilter(nextFilter);
  }, []);

  const goToPage = useCallback<Dispatch<SetStateAction<number>>>((nextPage) => {
    setPage((currentPage) => {
      const resolvedPage = typeof nextPage === "function" ? nextPage(currentPage) : nextPage;
      return Math.max(1, resolvedPage);
    });
  }, []);

  const loadGroupChildren = useCallback(async (groupId: string, page = 1, limit = 100) => {
    const params = new URLSearchParams({ expand: groupId, page: String(page), limit: String(limit) });
    if (filter.entityType) params.set("entityType", filter.entityType);
    if (filter.action) params.set("action", filter.action);

    const data = await api<{ rows: ActivityFeedEntryRecord[]; total: number }>(
      `/admin/audit?${params}`
    );
    return data;
  }, [filter]);

  return {
    rows,
    total,
    totalLoading,
    totalError,
    hasMore,
    page,
    setPage: goToPage,
    loading,
    filter,
    setFilter: updateFilter,
    entityTypes,
    loadGroupChildren,
  };
}
