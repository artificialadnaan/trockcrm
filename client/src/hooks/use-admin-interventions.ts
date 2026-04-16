import { useCallback, useEffect, useRef, useState } from "react";
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
  errors: InterventionMutationError[];
}

export interface InterventionMutationError {
  caseId: string;
  message: string;
}

export interface InterventionMutationSummary {
  tone: "success" | "warning" | "error";
  message: string;
}

export interface InterventionQueueItem {
  id: string;
  businessKey: string;
  disconnectType: string;
  clusterKey: string | null;
  severity: string;
  status: "open" | "snoozed" | "resolved";
  escalated: boolean;
  reopenCount: number;
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

export interface InterventionQueueFilters {
  caseId?: string | null;
  severity?: string | null;
  disconnectType?: string | null;
  assigneeId?: string | null;
  repId?: string | null;
  companyId?: string | null;
  stageKey?: string | null;
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
  view?: InterventionWorkspaceView;
  clusterKey?: string | null;
  caseId?: string | null;
  severity?: string | null;
  disconnectType?: string | null;
  assigneeId?: string | null;
  repId?: string | null;
  companyId?: string | null;
  stageKey?: string | null;
}) {
  const params = new URLSearchParams();

  if (input.page && input.page > 0) params.set("page", String(input.page));
  if (input.pageSize && input.pageSize > 0) params.set("limit", String(input.pageSize));
  if (input.status && input.status !== "all") params.set("status", input.status);
  if (input.view && input.view !== "open") params.set("view", input.view);
  if (input.clusterKey) params.set("clusterKey", input.clusterKey);
  if (input.caseId) params.set("caseId", input.caseId);
  if (input.severity) params.set("severity", input.severity);
  if (input.disconnectType) params.set("disconnectType", input.disconnectType);
  if (input.assigneeId) params.set("assigneeId", input.assigneeId);
  if (input.repId) params.set("repId", input.repId);
  if (input.companyId) params.set("companyId", input.companyId);
  if (input.stageKey) params.set("stageKey", input.stageKey);

  const query = params.toString();
  return query ? `?${query}` : "";
}

export type InterventionWorkspaceView =
  | "open"
  | "all"
  | "escalated"
  | "unassigned"
  | "aging"
  | "repeat"
  | "generated-task-pending"
  | "overdue"
  | "snooze-breached";

export function buildInterventionWorkspacePath(input: {
  view?: InterventionWorkspaceView;
  clusterKey?: string | null;
  caseId?: string | null;
  severity?: string | null;
  disconnectType?: string | null;
  assigneeId?: string | null;
  repId?: string | null;
  companyId?: string | null;
  stageKey?: string | null;
}) {
  const params = new URLSearchParams();

  if (input.view && input.view !== "open") params.set("view", input.view);
  if (input.clusterKey) params.set("clusterKey", input.clusterKey);
  if (input.companyId) params.set("companyId", input.companyId);
  if (input.assigneeId) params.set("assigneeId", input.assigneeId);
  if (input.repId) params.set("repId", input.repId);
  if (input.severity) params.set("severity", input.severity);
  if (input.disconnectType) params.set("disconnectType", input.disconnectType);
  if (input.caseId) params.set("caseId", input.caseId);
  if (input.stageKey) params.set("stageKey", input.stageKey);

  const query = params.toString();
  return query ? `/admin/interventions?${query}` : "/admin/interventions";
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatInterventionMutationErrors(errors: InterventionMutationError[]) {
  return errors.map((error) => `${error.caseId}: ${error.message}`).join("; ");
}

function pluralizeLabel(count: number, singularLabel: string) {
  return count === 1 ? singularLabel : `${singularLabel}s`;
}

function formatCountedLabel(count: number, singularLabel: string) {
  return pluralize(count, singularLabel, pluralizeLabel(count, singularLabel));
}

export function hasInterventionMutationErrors(result: InterventionMutationResult) {
  return result.errors.length > 0;
}

export function summarizeInterventionMutationResult(
  result: InterventionMutationResult,
  options?: { successLabel?: string; skippedLabel?: string; failureLabel?: string }
): InterventionMutationSummary {
  const successLabel = options?.successLabel ?? "intervention case";
  const skippedLabel = options?.skippedLabel ?? "case";
  const failureLabel = options?.failureLabel ?? "intervention case";
  const hasErrors = hasInterventionMutationErrors(result);

  if (result.updatedCount === 0) {
    const parts: string[] = [];
    const failureCountLabel = pluralizeLabel(Math.max(result.updatedCount + result.skippedCount, 2), failureLabel);
    parts.push(`No ${failureCountLabel} were updated`);
    if (result.skippedCount > 0) parts.push(`${formatCountedLabel(result.skippedCount, skippedLabel)} skipped`);
    if (hasErrors) parts.push(`Errors: ${formatInterventionMutationErrors(result.errors)}`);
    const message = `${parts.join(". ")}${!hasErrors && result.skippedCount > 0 ? "." : ""}`;

    return {
      tone: "error",
      message,
    };
  }

  const parts: string[] = [`Updated ${formatCountedLabel(result.updatedCount, successLabel)}`];
  if (result.skippedCount > 0) parts.push(`${formatCountedLabel(result.skippedCount, skippedLabel)} skipped`);
  if (hasErrors) parts.push(`Errors: ${formatInterventionMutationErrors(result.errors)}`);
  const message = `${parts.join(". ")}${!hasErrors && result.skippedCount > 0 ? "." : ""}`;

  return {
    tone: result.skippedCount > 0 || hasErrors ? "warning" : "success",
    message,
  };
}

export function toLocalDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function localDateTimeInputToIso(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date/time");
  return date.toISOString();
}

export function useAdminInterventions(input: {
  page?: number;
  pageSize?: number;
  status?: InterventionStatusFilter;
  view?: InterventionWorkspaceView;
  clusterKey?: string | null;
  caseId?: string | null;
  severity?: string | null;
  disconnectType?: string | null;
  assigneeId?: string | null;
  repId?: string | null;
  companyId?: string | null;
  stageKey?: string | null;
} = {}) {
  const {
    page = 1,
    pageSize = 50,
    status = "all",
    view = "open",
    clusterKey = null,
    caseId = null,
    severity = null,
    disconnectType = null,
    assigneeId = null,
    repId = null,
    companyId = null,
    stageKey = null,
  } = input;
  const [data, setData] = useState<InterventionQueueResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const query = buildAdminInterventionQuery({
        page,
        pageSize,
        status,
        view,
        clusterKey,
        caseId,
        severity,
        disconnectType,
        assigneeId,
        repId,
        companyId,
        stageKey,
      });
      const response = await api<InterventionQueueResult>(`/ai/ops/interventions${query}`);
      if (requestVersion !== requestVersionRef.current) return;
      setData(response);
    } catch (err: unknown) {
      if (requestVersion !== requestVersionRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load intervention queue");
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [assigneeId, caseId, clusterKey, companyId, disconnectType, page, pageSize, repId, severity, stageKey, status, view]);

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
  const requestVersionRef = useRef(0);

  const fetchData = useCallback(async () => {
    if (!caseId) {
      requestVersionRef.current += 1;
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api<InterventionCaseDetail>(`/ai/ops/interventions/${caseId}`);
      if (requestVersion !== requestVersionRef.current) return;
      setDetail(response);
    } catch (err: unknown) {
      if (requestVersion !== requestVersionRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load intervention detail");
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
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
      snoozedUntil: localDateTimeInputToIso(input.snoozedUntil),
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
      snoozedUntil: localDateTimeInputToIso(input.snoozedUntil),
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
