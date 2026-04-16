import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

export type InterventionStatusFilter = "all" | "open" | "snoozed" | "resolved";
export type InterventionResolutionReason =
  | "task_completed"
  | "follow_up_completed"
  | "owner_aligned"
  | "false_positive"
  | "duplicate_case"
  | "issue_no_longer_relevant";

export interface InterventionMutationResult {
  updatedCount: number;
  skippedCount: number;
}

export interface InterventionQueueItem {
  id: string;
  businessKey: string;
  disconnectType: string;
  clusterKey: string | null;
  severity: string;
  status: "open" | "snoozed" | "resolved";
  escalated: boolean;
  ageDays: number;
  assignedTo: string | null;
  generatedTask: {
    id: string;
    status: string;
    assignedTo: string | null;
    title: string;
  } | null;
  deal: { id: string; dealNumber: string; name: string } | null;
  company: { id: string; name: string } | null;
  evidenceSummary: string | null;
  lastIntervention: { actionType: string; actedAt: string } | null;
}

export interface InterventionQueueResult {
  items: InterventionQueueItem[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface InterventionCaseDetail {
  case: {
    id: string;
    businessKey: string;
    disconnectType: string;
    clusterKey: string | null;
    severity: string;
    status: "open" | "snoozed" | "resolved";
    assignedTo: string | null;
    generatedTaskId: string | null;
    escalated: boolean;
    snoozedUntil: string | null;
    reopenCount: number;
    lastDetectedAt: string;
    lastIntervenedAt: string | null;
    resolvedAt: string | null;
    resolutionReason: string | null;
    metadataJson: Record<string, unknown> | null;
  };
  generatedTask: {
    id: string;
    title: string;
    status: string;
    assignedTo: string | null;
  } | null;
  crm: {
    deal: { id: string; dealNumber: string; name: string } | null;
    company: { id: string; name: string } | null;
  };
  history: Array<{
    id: string;
    actionType: string;
    actedBy: string;
    actedAt: string;
    fromStatus: string | null;
    toStatus: string | null;
    fromAssignee: string | null;
    toAssignee: string | null;
    fromSnoozedUntil: string | null;
    toSnoozedUntil: string | null;
    notes: string | null;
    metadataJson: Record<string, unknown> | null;
  }>;
}

export const INTERVENTION_RESOLUTION_OPTIONS: Array<{
  value: InterventionResolutionReason;
  label: string;
}> = [
  { value: "task_completed", label: "Task completed" },
  { value: "follow_up_completed", label: "Follow-up completed" },
  { value: "owner_aligned", label: "Owner aligned" },
  { value: "false_positive", label: "False positive" },
  { value: "duplicate_case", label: "Duplicate case" },
  { value: "issue_no_longer_relevant", label: "Issue no longer relevant" },
];

export function buildAdminInterventionQuery(input: {
  page?: number;
  pageSize?: number;
  status?: InterventionStatusFilter;
}) {
  const params = new URLSearchParams();

  if (input.page && input.page > 0) params.set("page", String(input.page));
  if (input.pageSize && input.pageSize > 0) params.set("limit", String(input.pageSize));
  if (input.status && input.status !== "all") params.set("status", input.status);

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function useAdminInterventions(input: {
  page?: number;
  pageSize?: number;
  status?: InterventionStatusFilter;
} = {}) {
  const { page = 1, pageSize = 50, status = "all" } = input;
  const [data, setData] = useState<InterventionQueueResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = buildAdminInterventionQuery({ page, pageSize, status });
      const response = await api<InterventionQueueResult>(`/ai/ops/interventions${query}`);
      setData(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load intervention queue");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}

export function useAdminInterventionDetail(caseId: string | null) {
  const [detail, setDetail] = useState<InterventionCaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!caseId) {
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await api<InterventionCaseDetail>(`/ai/ops/interventions/${caseId}`);
      setDetail(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load intervention detail");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    detail,
    loading,
    error,
    refetch: fetchData,
  };
}

export async function batchAssignInterventions(input: {
  caseIds: string[];
  assignedTo: string;
  notes?: string | null;
}) {
  return api<InterventionMutationResult>("/ai/ops/interventions/batch-assign", {
    method: "POST",
    json: {
      caseIds: input.caseIds,
      assignedTo: input.assignedTo,
      notes: input.notes ?? null,
    },
  });
}

export async function batchSnoozeInterventions(input: {
  caseIds: string[];
  snoozedUntil: string;
  notes?: string | null;
}) {
  return api<InterventionMutationResult>("/ai/ops/interventions/batch-snooze", {
    method: "POST",
    json: {
      caseIds: input.caseIds,
      snoozedUntil: input.snoozedUntil,
      notes: input.notes ?? null,
    },
  });
}

export async function batchResolveInterventions(input: {
  caseIds: string[];
  resolutionReason: InterventionResolutionReason;
  notes?: string | null;
}) {
  return api<InterventionMutationResult>("/ai/ops/interventions/batch-resolve", {
    method: "POST",
    json: {
      caseIds: input.caseIds,
      resolutionReason: input.resolutionReason,
      notes: input.notes ?? null,
    },
  });
}

export async function batchEscalateInterventions(input: {
  caseIds: string[];
  notes?: string | null;
}) {
  return api<InterventionMutationResult>("/ai/ops/interventions/batch-escalate", {
    method: "POST",
    json: {
      caseIds: input.caseIds,
      notes: input.notes ?? null,
    },
  });
}

export async function assignIntervention(caseId: string, input: { assignedTo: string; notes?: string | null }) {
  return api<InterventionMutationResult>(`/ai/ops/interventions/${caseId}/assign`, {
    method: "POST",
    json: {
      assignedTo: input.assignedTo,
      notes: input.notes ?? null,
    },
  });
}

export async function snoozeIntervention(caseId: string, input: { snoozedUntil: string; notes?: string | null }) {
  return api<InterventionMutationResult>(`/ai/ops/interventions/${caseId}/snooze`, {
    method: "POST",
    json: {
      snoozedUntil: input.snoozedUntil,
      notes: input.notes ?? null,
    },
  });
}

export async function resolveIntervention(
  caseId: string,
  input: { resolutionReason: InterventionResolutionReason; notes?: string | null }
) {
  return api<InterventionMutationResult>(`/ai/ops/interventions/${caseId}/resolve`, {
    method: "POST",
    json: {
      resolutionReason: input.resolutionReason,
      notes: input.notes ?? null,
    },
  });
}

export async function escalateIntervention(caseId: string, input?: { notes?: string | null }) {
  return api<InterventionMutationResult>(`/ai/ops/interventions/${caseId}/escalate`, {
    method: "POST",
    json: {
      notes: input?.notes ?? null,
    },
  });
}
