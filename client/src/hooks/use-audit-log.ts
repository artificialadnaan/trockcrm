import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface AuditLogRow {
  id: number;
  tableName: string;
  recordId: string;
  action: "insert" | "update" | "delete";
  changedBy: string | null;
  changedByName: string | null;
  changes: Record<string, { old: unknown; new: unknown }>;
  fullRow: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogFilter {
  tableName?: string;
  recordId?: string;
  changedBy?: string;
  action?: string;
  fromDate?: string;
  toDate?: string;
}

export function useAuditLog() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AuditLogFilter>({});
  const [tables, setTables] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (filter.tableName) params.set("tableName", filter.tableName);
      if (filter.recordId) params.set("recordId", filter.recordId);
      if (filter.changedBy) params.set("changedBy", filter.changedBy);
      if (filter.action) params.set("action", filter.action);
      if (filter.fromDate) params.set("fromDate", filter.fromDate);
      if (filter.toDate) params.set("toDate", filter.toDate);

      const data = await api<{ rows: AuditLogRow[]; total: number }>(
        `/admin/audit?${params}`
      );
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  const loadTables = useCallback(async () => {
    try {
      const data = await api<{ tables: string[] }>("/admin/audit/tables");
      setTables(data.tables);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTables(); }, [loadTables]);

  return { rows, total, page, setPage, loading, filter, setFilter, tables };
}
