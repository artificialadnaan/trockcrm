import { useState, useEffect, useCallback, useRef } from "react";
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
  const [total, setTotal] = useState<number | null>(null);
  const [totalLoading, setTotalLoading] = useState(true);
  const [totalError, setTotalError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AuditLogFilter>({});
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const totalRequestIdRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (filter.entityType) params.set("entityType", filter.entityType);
      if (filter.actorQuery) params.set("actorQuery", filter.actorQuery);
      if (filter.action) params.set("action", filter.action);
      if (filter.fromDate) params.set("fromDate", filter.fromDate);
      if (filter.toDate) params.set("toDate", filter.toDate);

      const data = await api<{ rows: ActivityFeedItemRecord[]; hasMore: boolean }>(
        `/admin/audit?${params}`
      );
      setRows(data.rows);
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  const loadTotal = useCallback(async () => {
    const requestId = totalRequestIdRef.current + 1;
    totalRequestIdRef.current = requestId;
    setTotalLoading(true);
    setTotalError(false);
    setTotal(null);
    try {
      const params = new URLSearchParams();
      if (filter.entityType) params.set("entityType", filter.entityType);
      if (filter.actorQuery) params.set("actorQuery", filter.actorQuery);
      if (filter.action) params.set("action", filter.action);
      if (filter.fromDate) params.set("fromDate", filter.fromDate);
      if (filter.toDate) params.set("toDate", filter.toDate);

      const data = await api<{ total: number }>(`/admin/audit/count?${params}`);
      if (totalRequestIdRef.current === requestId) {
        setTotal(data.total);
      }
    } catch {
      if (totalRequestIdRef.current === requestId) {
        setTotalError(true);
      }
    } finally {
      if (totalRequestIdRef.current === requestId) {
        setTotalLoading(false);
      }
    }
  }, [filter]);

  const loadEntityTypes = useCallback(async () => {
    try {
      const data = await api<{ entityTypes: string[] }>("/admin/audit/entity-types");
      setEntityTypes(data.entityTypes);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadTotal(); }, [loadTotal]);
  useEffect(() => { void loadEntityTypes(); }, [loadEntityTypes]);

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
    setPage,
    loading,
    filter,
    setFilter,
    entityTypes,
    loadGroupChildren,
  };
}
