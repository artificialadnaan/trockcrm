import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { FileRecord } from "./use-files";

export type WorkflowRoute = "estimating" | "service";
export type DealScopingIntakeStatus = "draft" | "ready" | "activated";

export interface DealScopingSectionData {
  [sectionKey: string]: unknown;
}

export interface DealScopingCompletionStateEntry {
  isComplete: boolean;
  missingFields: string[];
  missingAttachments: string[];
}

export interface DealScopingAttachmentRequirement {
  key: string;
  category: string;
  label: string;
  satisfied: boolean;
}

export interface DealScopingReadiness {
  status: DealScopingIntakeStatus;
  errors: {
    sections: Record<string, string[]>;
    attachments: Record<string, string[]>;
  };
  completionState: Record<string, DealScopingCompletionStateEntry>;
  requiredSections: string[];
  requiredAttachmentKeys: string[];
  attachmentRequirements: DealScopingAttachmentRequirement[];
}

export interface DealScopingIntake {
  id: string;
  dealId: string;
  officeId: string;
  workflowRouteSnapshot: WorkflowRoute;
  status: DealScopingIntakeStatus;
  projectTypeId: string | null;
  sectionData: DealScopingSectionData;
  completionState: Record<string, DealScopingCompletionStateEntry>;
  readinessErrors: {
    sections: Record<string, string[]>;
    attachments: Record<string, string[]>;
  };
  firstReadyAt: string | null;
  activatedAt: string | null;
  lastAutosavedAt: string;
  createdBy: string;
  lastEditedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Deal {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  workflowRoute: WorkflowRoute;
  assignedRepId: string;
  companyId: string | null;
  propertyId: string | null;
  sourceLeadId: string | null;
  primaryContactId: string | null;
  ddEstimate: string | null;
  bidEstimate: string | null;
  awardedAmount: string | null;
  changeOrderTotal: string | null;
  description: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  projectTypeId: string | null;
  regionId: string | null;
  source: string | null;
  winProbability: number | null;
  procoreProjectId: number | null;
  procoreBidId: number | null;
  procoreLastSyncedAt: string | null;
  lostReasonId: string | null;
  lostNotes: string | null;
  lostCompetitor: string | null;
  lostAt: string | null;
  expectedCloseDate: string | null;
  actualCloseDate: string | null;
  lastActivityAt: string | null;
  stageEnteredAt: string;
  isActive: boolean;
  hubspotDealId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DealDetail extends Deal {
  proposalStatus: string | null;
  proposalSentAt: string | null;
  proposalAcceptedAt: string | null;
  proposalRevisionCount: number | null;
  proposalNotes: string | null;
  estimatingSubstage: string | null;
  stageHistory: Array<{
    id: string;
    dealId: string;
    fromStageId: string | null;
    toStageId: string;
    changedBy: string;
    isBackwardMove: boolean;
    isDirectorOverride: boolean;
    overrideReason: string | null;
    durationInPreviousStage: string | null;
    createdAt: string;
  }>;
  approvals: Array<{
    id: string;
    dealId: string;
    targetStageId: string;
    requiredRole: string;
    requestedBy: string;
    approvedBy: string | null;
    status: string;
    notes: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  changeOrders: Array<{
    id: string;
    dealId: string;
    coNumber: number;
    title: string;
    amount: string;
    status: string;
    procoreCoId: number | null;
    approvedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface DealFilters {
  search?: string;
  stageIds?: string[];
  assignedRepId?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  isActive?: boolean;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useDeals(filters: DealFilters = {}) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.stageIds?.length) params.set("stageIds", filters.stageIds.join(","));
      if (filters.assignedRepId) params.set("assignedRepId", filters.assignedRepId);
      if (filters.projectTypeId) params.set("projectTypeId", filters.projectTypeId);
      if (filters.regionId) params.set("regionId", filters.regionId);
      if (filters.source) params.set("source", filters.source);
      if (filters.isActive === false) params.set("isActive", "false");
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortDir) params.set("sortDir", filters.sortDir);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ deals: Deal[]; pagination: Pagination }>(
        `/deals${qs ? `?${qs}` : ""}`
      );
      setDeals(data.deals);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deals");
    } finally {
      setLoading(false);
    }
  }, [
    filters.search,
    filters.stageIds?.join(","),
    filters.assignedRepId,
    filters.projectTypeId,
    filters.regionId,
    filters.source,
    filters.isActive,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, pagination, loading, error, refetch: fetchDeals };
}

export function useDealDetail(dealId: string | undefined) {
  const [deal, setDeal] = useState<DealDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDeal = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ deal: DealDetail }>(`/deals/${dealId}/detail`);
      setDeal(data.deal);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deal");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchDeal();
  }, [fetchDeal]);

  return { deal, loading, error, refetch: fetchDeal };
}

export async function createDeal(input: Partial<Deal> & { name: string; stageId: string }) {
  return api<{ deal: Deal }>("/deals", { method: "POST", json: input });
}

export async function updateDeal(dealId: string, input: Partial<Deal>) {
  return api<{ deal: Deal }>(`/deals/${dealId}`, { method: "PATCH", json: input });
}

export async function changeDealStage(
  dealId: string,
  targetStageId: string,
  options?: {
    overrideReason?: string;
    lostReasonId?: string;
    lostNotes?: string;
    lostCompetitor?: string;
  }
) {
  return api<{ deal: Deal; eventsEmitted: string[] }>(`/deals/${dealId}/stage`, {
    method: "POST",
    json: { targetStageId, ...options },
  });
}

export async function preflightStageCheck(dealId: string, targetStageId: string) {
  return api<{
    allowed: boolean;
    isBackwardMove: boolean;
    isTerminal: boolean;
    targetStage: { id: string; name: string; slug: string; isTerminal: boolean };
    currentStage: { id: string; name: string; slug: string; isTerminal: boolean };
    missingRequirements: {
      fields: string[];
      documents: string[];
      approvals: string[];
    };
    requiresOverride: boolean;
    overrideType: string | null;
    blockReason: string | null;
  }>(`/deals/${dealId}/stage/preflight`, {
    method: "POST",
    json: { targetStageId },
  });
}

export async function deleteDeal(dealId: string) {
  return api<{ success: boolean }>(`/deals/${dealId}`, { method: "DELETE" });
}

export async function getDealScopingIntake(dealId: string) {
  return api<{ intake: DealScopingIntake; readiness: DealScopingReadiness }>(
    `/deals/${dealId}/scoping-intake`
  );
}

export async function patchDealScopingIntake(
  dealId: string,
  input: Partial<{
    workflowRoute: WorkflowRoute;
    projectTypeId: string | null;
    sectionData: DealScopingSectionData;
  }> &
    Record<string, unknown>
) {
  return api<{ intake: DealScopingIntake; readiness: DealScopingReadiness }>(
    `/deals/${dealId}/scoping-intake`,
    { method: "PATCH", json: input }
  );
}

export async function getDealScopingReadiness(dealId: string) {
  return api<{ readiness: DealScopingReadiness }>(`/deals/${dealId}/scoping-intake/readiness`);
}

export async function linkExistingScopingAttachment(
  dealId: string,
  input: {
    fileId: string;
    intakeSection: string;
    intakeRequirementKey: string;
  }
) {
  return api<{ file: FileRecord }>(`/deals/${dealId}/scoping-intake/attachments/link-existing`, {
    method: "POST",
    json: input,
  });
}

export async function activateServiceHandoff(dealId: string) {
  return api<{ activated: true }>(`/deals/${dealId}/service-handoff/activate`, {
    method: "POST",
  });
}
