import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { ActivityFeedEntryRecord } from "@/components/audit/activity-feed-entry";

export interface AuditLogFilter {
  entityType?: string;
  actorQuery?: string;
  action?: string;
  fromDate?: string;
  toDate?: string;
}

export function useAuditLog() {
  const [rows, setRows] = useState<ActivityFeedEntryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AuditLogFilter>({});
  const [entityTypes, setEntityTypes] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (filter.entityType) params.set("entityType", filter.entityType);
      if (filter.actorQuery) params.set("actorQuery", filter.actorQuery);
      if (filter.action) params.set("action", filter.action);
      if (filter.fromDate) params.set("fromDate", filter.fromDate);
      if (filter.toDate) params.set("toDate", filter.toDate);

      const data = await api<{ rows: ActivityFeedEntryRecord[]; total: number }>(
        `/admin/audit?${params}`
      );
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

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

  return { rows, total, page, setPage, loading, filter, setFilter, entityTypes };
}
