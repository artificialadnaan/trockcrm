import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

export interface MigrationSummary {
  deals: Record<string, number>;
  contacts: Record<string, number>;
  activities: Record<string, number>;
  companies: Record<string, number>;
  properties: Record<string, number>;
  leads: Record<string, number>;
  recentRuns: ImportRun[];
}

export interface MigrationExceptionItem {
  id: string;
  entityType: "company" | "property" | "lead" | "deal" | "contact" | "activity";
  bucket:
    | "unknown_company"
    | "ambiguous_property"
    | "ambiguous_contact"
    | "ambiguous_deal_association"
    | "lead_vs_deal_conflict"
    | "ambiguous_email_activity_attribution"
    | "missing_owner_assignment";
  title: string;
  detail: string;
  validationStatus: string;
  reviewNotes: string | null;
  reviewable: boolean;
  reviewHint: string;
}

export interface MigrationExceptionGroup {
  bucket: MigrationExceptionItem["bucket"];
  label: string;
  count: number;
  items: MigrationExceptionItem[];
}

export interface MigrationExceptionsResponse {
  groups: MigrationExceptionGroup[];
}

export interface ImportRun {
  id: string;
  type: "extract" | "validate" | "promote";
  status: "running" | "completed" | "failed" | "rolled_back";
  stats: Record<string, unknown>;
  errorLog: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface StagedDeal {
  id: string;
  hubspotDealId: string;
  mappedName: string | null;
  mappedStage: string | null;
  mappedRepEmail: string | null;
  mappedAmount: number | null;
  mappedCloseDate: string | null;
  mappedSource: string | null;
  validationStatus: string;
  validationErrors: Array<{ field: string; error: string }>;
  validationWarnings: Array<{ field: string; warning: string }>;
  reviewNotes: string | null;
  promotedAt: string | null;
}

export interface StagedContact {
  id: string;
  hubspotContactId: string;
  mappedFirstName: string | null;
  mappedLastName: string | null;
  mappedEmail: string | null;
  mappedPhone: string | null;
  mappedCompany: string | null;
  mappedCategory: string;
  duplicateOfStagedId: string | null;
  validationStatus: string;
  validationErrors: Array<{ field: string; error: string }>;
  validationWarnings: Array<{ field: string; warning: string }>;
  promotedAt: string | null;
}

export interface StagedCompany {
  id: string;
  hubspotCompanyId: string;
  mappedName: string | null;
  mappedDomain: string | null;
  mappedPhone: string | null;
  mappedOwnerEmail: string | null;
  mappedLeadHint: string | null;
  validationStatus: string;
  validationErrors: Array<{ field: string; error: string }>;
  validationWarnings: Array<{ field: string; warning: string }>;
  exceptionBucket: string | null;
  exceptionReason: string | null;
  reviewNotes: string | null;
  promotedAt: string | null;
}

export interface StagedProperty {
  id: string;
  hubspotPropertyId: string;
  mappedName: string | null;
  mappedCompanyName: string | null;
  mappedCompanyDomain: string | null;
  mappedAddress: string | null;
  mappedCity: string | null;
  mappedState: string | null;
  mappedZip: string | null;
  mappedOwnerEmail: string | null;
  candidateCompanyCount: number;
  validationStatus: string;
  validationErrors: Array<{ field: string; error: string }>;
  validationWarnings: Array<{ field: string; warning: string }>;
  exceptionBucket: string | null;
  exceptionReason: string | null;
  reviewNotes: string | null;
  promotedAt: string | null;
}

export interface StagedLead {
  id: string;
  hubspotLeadId: string;
  mappedName: string | null;
  mappedCompanyName: string | null;
  mappedPropertyName: string | null;
  mappedDealName: string | null;
  candidateDealCount: number;
  candidatePropertyCount: number;
  mappedOwnerEmail: string | null;
  mappedSourceStage: string | null;
  mappedAmount: string | number | null;
  mappedCloseDate: string | null;
  validationStatus: string;
  validationErrors: Array<{ field: string; error: string }>;
  validationWarnings: Array<{ field: string; warning: string }>;
  exceptionBucket: string | null;
  exceptionReason: string | null;
  reviewNotes: string | null;
  promotedAt: string | null;
}

export interface OwnershipQueueRow {
  recordType: "lead" | "deal";
  recordId: string;
  recordName: string;
  officeId: string;
  officeName: string;
  assignedRepId: string | null;
  assignedUserName: string | null;
  reasonCode: string;
  reasonCodes: string[];
  severity: "high" | "medium" | "low";
  generatedAt: string | null;
  evaluatedAt: string | null;
}

export interface OwnershipQueueResponse {
  rows: OwnershipQueueRow[];
  byReason: Array<{ reasonCode: string; count: number }>;
}

export interface OfficeAssignee {
  id: string;
  displayName: string;
}

export interface OwnershipQueueFilters {
  officeId?: string;
  recordType?: "all" | "lead" | "deal";
  reasonCode?: string;
  staleAgeDays?: number | "all";
}

const EMPTY_OWNERSHIP_QUEUE: OwnershipQueueResponse = {
  rows: [],
  byReason: [],
};

function normalizeOwnershipQueueResponse(
  data: Partial<OwnershipQueueResponse> | null | undefined
): OwnershipQueueResponse {
  return {
    rows: data?.rows ?? [],
    byReason: data?.byReason ?? [],
  };
}

function buildOwnershipQueueQueryParams(filters: OwnershipQueueFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.officeId) params.set("officeId", filters.officeId);
  if (filters.recordType && filters.recordType !== "all") params.set("recordType", filters.recordType);
  if (filters.reasonCode) params.set("reasonCode", filters.reasonCode);
  if (filters.staleAgeDays && filters.staleAgeDays !== "all") {
    params.set("staleAgeDays", String(filters.staleAgeDays));
  }
  return params;
}

export function useMigrationSummary() {
  const [summary, setSummary] = useState<MigrationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<MigrationSummary>("/migration/summary");
      setSummary(data);
    } catch (err) {
      setError("Failed to load migration summary");
    } finally {
      setLoading(false);
    }
  }, []);

  const runValidation = async () => {
    await api("/migration/validate", { method: "POST" });
    await load();
  };

  useEffect(() => { load(); }, [load]);

  return { summary, loading, error, refetch: load, runValidation };
}

export function useMigrationExceptions() {
  const [exceptions, setExceptions] = useState<MigrationExceptionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<MigrationExceptionsResponse>("/migration/exceptions");
      setExceptions(data.groups ?? []);
    } catch (err) {
      setError("Failed to load migration exceptions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { exceptions, loading, error, refetch: load };
}

export function useOfficeOwnershipQueue(filters: OwnershipQueueFilters = {}) {
  const [data, setData] = useState<OwnershipQueueResponse>(EMPTY_OWNERSHIP_QUEUE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!filters.officeId) {
      setData(EMPTY_OWNERSHIP_QUEUE);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const params = buildOwnershipQueueQueryParams(filters);
      const data = await api<OwnershipQueueResponse>(
        `/admin/cleanup/office?${params.toString()}`,
        {
          headers: filters.officeId ? { "x-office-id": filters.officeId } : undefined,
        }
      );
      setData(normalizeOwnershipQueueResponse(data));
    } catch (err) {
      setData(EMPTY_OWNERSHIP_QUEUE);
      setError("Failed to load ownership queue");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    rows: data.rows,
    byReason: data.byReason,
    loading,
    error,
    refetch: load,
  };
}

export async function bulkReassignOwnershipQueueRows(input: {
  officeId: string;
  rows: Array<{ recordType: "lead" | "deal"; recordId: string }>;
  assigneeId: string;
}) {
  return api("/admin/cleanup/reassign", {
    method: "POST",
    json: input,
    headers: {
      "x-office-id": input.officeId,
    },
  });
}

export function useStagedDeals(validationStatus?: string) {
  const [rows, setRows] = useState<StagedDeal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (validationStatus) params.set("validationStatus", validationStatus);
      const data = await api<{ rows: StagedDeal[]; total: number }>(
        `/migration/deals?${params}`
      );
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, validationStatus]);

  const approve = async (id: string) => {
    await api(`/migration/deals/${id}/approve`, { method: "POST" });
    await load();
  };

  const reject = async (id: string, notes?: string) => {
    await api(`/migration/deals/${id}/reject`, {
      method: "POST",
      json: { notes },
    });
    await load();
  };

  const batchApprove = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await api("/migration/deals/batch-approve", {
      method: "POST",
      json: { ids },
    });
    setSelected(new Set());
    await load();
  };

  useEffect(() => { load(); }, [load]);

  return { rows, total, page, setPage, loading, selected, setSelected, approve, reject, batchApprove, refetch: load };
}

export function useStagedContacts(validationStatus?: string) {
  const [rows, setRows] = useState<StagedContact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (validationStatus) params.set("validationStatus", validationStatus);
      const data = await api<{ rows: StagedContact[]; total: number }>(
        `/migration/contacts?${params}`
      );
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, validationStatus]);

  const approve = async (id: string) => {
    await api(`/migration/contacts/${id}/approve`, { method: "POST" });
    await load();
  };

  const reject = async (id: string, notes?: string) => {
    await api(`/migration/contacts/${id}/reject`, {
      method: "POST",
      json: { notes },
    });
    await load();
  };

  const merge = async (id: string, mergeTargetId: string) => {
    await api(`/migration/contacts/${id}/merge`, {
      method: "POST",
      json: { mergeTargetId },
    });
    await load();
  };

  const batchApprove = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await api("/migration/contacts/batch-approve", {
      method: "POST",
      json: { ids },
    });
    setSelected(new Set());
    await load();
  };

  useEffect(() => { load(); }, [load]);

  return { rows, total, page, setPage, loading, selected, setSelected, approve, reject, merge, batchApprove, refetch: load };
}

function useStagedQueue<T extends { id: string }>(
  endpoint: string,
  validationStatus?: string
) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (validationStatus) params.set("validationStatus", validationStatus);
      const data = await api<{ rows: T[]; total: number }>(`${endpoint}?${params}`);
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [endpoint, page, validationStatus]);

  const approve = async (id: string) => {
    await api(`${endpoint}/${id}/approve`, { method: "POST" });
    await load();
  };

  const reject = async (id: string, notes?: string) => {
    await api(`${endpoint}/${id}/reject`, { method: "POST", json: { notes } });
    await load();
  };

  useEffect(() => { load(); }, [load]);

  return { rows, total, page, setPage, loading, approve, reject, refetch: load };
}

export function useStagedCompanies(validationStatus?: string) {
  return useStagedQueue<StagedCompany>("/migration/companies", validationStatus);
}

export function useStagedProperties(validationStatus?: string) {
  return useStagedQueue<StagedProperty>("/migration/properties", validationStatus);
}

export function useStagedLeads(validationStatus?: string) {
  return useStagedQueue<StagedLead>("/migration/leads", validationStatus);
}
