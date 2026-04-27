import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { FileRecord } from "./use-files";
export { getDealStageMetadata, getWorkflowRouteLabel } from "@/lib/pipeline-ownership";
import type { StagePageQuery } from "@/lib/pipeline-stage-page";

export type WorkflowRoute = "normal" | "service";
export type DealScopingIntakeStatus = "draft" | "ready" | "activated";
export type DealPipelineDisposition = "opportunity" | "deals" | "service";
export type DealDepartment = "sales" | "estimating" | "client_services" | "operations";

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

export interface DealResolvedFields {
  projectTypeId: string | null;
  companyId: string | null;
  sourceCategory: string | null;
  sourceDetail: string | null;
  legacySource: string | null;
  propertyId: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  primaryContactId: string | null;
  assignedRepId: string | null;
  workflowRoute: WorkflowRoute;
  description: string | null;
  bidDueDate: string | boolean | number | null;
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

export interface DealPaymentEvent {
  id: string;
  dealId: string;
  recordedByUserId: string | null;
  paidAt: string;
  grossRevenueAmount: string;
  grossMarginAmount: string | null;
  isCreditMemo: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Deal {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  pipelineDisposition: DealPipelineDisposition;
  workflowRoute: WorkflowRoute | null;
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
  decisionMakerName: string | null;
  decisionProcess: string | null;
  budgetStatus: string | null;
  incumbentVendor: string | null;
  unitCount: number | null;
  buildYear: number | null;
  forecastWindow: "30_days" | "60_days" | "90_days" | "beyond_90" | "uncommitted" | null;
  forecastCategory: "commit" | "best_case" | "pipeline" | null;
  forecastConfidencePercent: number | null;
  forecastRevenue: string | null;
  forecastGrossProfit: string | null;
  forecastBlockers: string | null;
  nextStep: string | null;
  nextStepDueAt: string | null;
  nextMilestoneAt: string | null;
  supportNeededType: "leadership" | "estimating" | "operations" | "executive_team" | null;
  supportNeededNotes: string | null;
  forecastUpdatedAt: string | null;
  forecastUpdatedBy: string | null;
  procoreProjectId: number | null;
  procoreBidId: number | null;
  procoreLastSyncedAt: string | null;
  isBidBoardOwned: boolean;
  bidBoardStageSlug: string | null;
  readOnlySyncedAt: string | null;
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
  bidBoardOwnership?: {
    isOwned: boolean;
    sourceOfTruth: "crm" | "bid_board";
    handoffStageSlug: string;
    downstreamStagesReadOnly: boolean;
    canEditInCrm: string[];
    mirroredInCrm: string[];
    reason: string;
    message: string;
  };
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
  routingHistory: Array<{
    id: string;
    dealId: string;
    fromWorkflowRoute: WorkflowRoute | null;
    toWorkflowRoute: WorkflowRoute;
    valueSource: string;
    triggeringValue: string;
    reason: string | null;
    changedBy: string;
    createdAt: string;
  }>;
  departmentOwnership: {
    currentDepartment: DealDepartment;
    acceptanceStatus: "pending" | "accepted";
    effectiveOwnerUserId: string | null;
    pendingDepartment: DealDepartment | null;
  };
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

export interface DealBoardColumn {
  stage: {
    id: string;
    name: string;
    slug: string;
    color?: string | null;
    displayOrder?: number;
    isActivePipeline?: boolean;
    isTerminal?: boolean;
  };
  count: number;
  totalValue: number;
  cards: Deal[];
}

export interface DealBoardResponse {
  columns: DealBoardColumn[];
  terminalStages: Array<{
    stage: DealBoardColumn["stage"];
    count: number;
    deals: Deal[];
  }>;
}

export interface DealStagePageResponse {
  stage: DealBoardColumn["stage"];
  scope: "mine" | "team" | "all";
  summary: { count: number; totalValue: number; averageDaysInStage: number | null };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  rows: Array<
    Deal & {
      assignedRepName?: string;
      daysInStage?: number;
    }
  >;
}

interface DealBoardApiColumn extends Omit<DealBoardColumn, "cards"> {
  deals?: Deal[];
  cards?: Deal[];
}

interface DealBoardApiResponse {
  pipelineColumns: Array<{
    stage: DealBoardColumn["stage"];
    count: number;
    totalValue: number;
    deals: Deal[];
  }>;
  terminalStages: DealBoardResponse["terminalStages"];
  columns?: DealBoardApiColumn[];
}

export function normalizeDealBoardResponse(result: DealBoardApiResponse): DealBoardResponse {
  const normalizedColumns = (result.columns ?? result.pipelineColumns).map((column) => {
    const sourceColumn = column as DealBoardApiColumn;
    return {
      ...column,
      cards: sourceColumn.cards ?? sourceColumn.deals ?? [],
    };
  });

  return {
    columns: normalizedColumns,
    terminalStages: result.terminalStages ?? [],
  };
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

export type UpdateDealPayload = Partial<Deal> & {
  migrationMode?: boolean;
};

export async function updateDeal(dealId: string, input: UpdateDealPayload) {
  return api<{ deal: Deal }>(`/deals/${dealId}`, { method: "PATCH", json: input });
}

export async function getDealPayments(dealId: string) {
  return api<{ payments: DealPaymentEvent[] }>(`/deals/${dealId}/payments`);
}

export async function createDealPayment(
  dealId: string,
  input: {
    paidAt: string;
    grossRevenueAmount: number;
    grossMarginAmount?: number | null;
    isCreditMemo?: boolean;
    notes?: string | null;
  }
) {
  return api<{ payment: DealPaymentEvent }>(`/deals/${dealId}/payments`, {
    method: "POST",
    json: input,
  });
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
    bidBoardLocked?: boolean;
    bidBoardOwnership?: {
      isOwned: boolean;
      sourceOfTruth: "crm" | "bid_board";
      handoffStageSlug: string;
      downstreamStagesReadOnly: boolean;
      canEditInCrm: string[];
      mirroredInCrm: string[];
      reason: string;
      message: string;
    } | null;
  }>(`/deals/${dealId}/stage/preflight`, {
    method: "POST",
    json: { targetStageId },
  });
}

export async function deleteDeal(dealId: string) {
  return api<{ success: boolean }>(`/deals/${dealId}`, { method: "DELETE" });
}

export async function getDealScopingIntake(dealId: string) {
  return api<{ intake: DealScopingIntake; readiness: DealScopingReadiness; resolved: DealResolvedFields }>(
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
  return api<{ intake: DealScopingIntake; readiness: DealScopingReadiness; resolved: DealResolvedFields }>(
    `/deals/${dealId}/scoping-intake`,
    { method: "PATCH", json: input }
  );
}

export async function patchResolvedDealFields(
  dealId: string,
  input: Partial<Record<keyof DealResolvedFields | "preBidMeetingCompleted" | "siteVisitDecision" | "siteVisitCompleted" | "estimatorConsultationNotes", unknown>>
) {
  return api<{ resolved: { resolved: DealResolvedFields } }>(`/deals/${dealId}/resolved-fields`, {
    method: "PATCH",
    json: input,
  });
}

export async function applyOpportunityRoutingReview(
  dealId: string,
  input: {
    valueSource: "sales_estimated_opportunity_value" | "procore_bidboard_estimate";
    amount: string;
    reason?: string;
  }
) {
  return api<{ deal: Deal }>(`/deals/${dealId}/routing-review`, {
    method: "POST",
    json: input,
  });
}

export async function getDealScopingReadiness(dealId: string) {
  return api<{ readiness: DealScopingReadiness }>(`/deals/${dealId}/scoping-intake/readiness`);
}

export function useDealBoard(scope: "mine" | "team" | "all", includeDd: boolean) {
  const [board, setBoard] = useState<DealBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return api<DealBoardApiResponse>(`/deals/pipeline?scope=${scope}&includeDd=${includeDd}&previewLimit=8`)
      .then((result) => {
        const normalized = normalizeDealBoardResponse(result);
        setBoard(normalized);
        return normalized;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load deal board");
        throw err;
      })
      .finally(() => setLoading(false));
  }, [includeDd, scope]);

  useEffect(() => {
    void refetch().catch(() => undefined);
  }, [refetch]);

  return { board, loading, error, refetch };
}

export function useDealStagePage(input: StagePageQuery & { stageId: string; scope: "mine" | "team" | "all" }) {
  const [data, setData] = useState<DealStagePageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      scope: input.scope,
      page: String(input.page),
      pageSize: String(input.pageSize),
      sort: input.sort,
      search: input.search,
      ...(input.filters.assignedRepId ? { assignedRepId: input.filters.assignedRepId } : {}),
      ...(input.filters.staleOnly ? { staleOnly: "true" } : {}),
      ...(input.filters.status ? { status: input.filters.status } : {}),
      ...(input.filters.workflowRoute ? { workflowRoute: input.filters.workflowRoute } : {}),
      ...(input.filters.source ? { source: input.filters.source } : {}),
      ...(input.filters.regionId ? { regionId: input.filters.regionId } : {}),
      ...(input.filters.updatedAfter ? { updatedAfter: input.filters.updatedAfter } : {}),
      ...(input.filters.updatedBefore ? { updatedBefore: input.filters.updatedBefore } : {}),
      ...(input.filters.minAgeDays ? { minAgeDays: input.filters.minAgeDays } : {}),
      ...(input.filters.maxAgeDays ? { maxAgeDays: input.filters.maxAgeDays } : {}),
    });

    setLoading(true);
    setError(null);
    setData(null);

    void api<DealStagePageResponse>(`/deals/stages/${input.stageId}?${params.toString()}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load stage");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    input.filters.assignedRepId,
    input.filters.source,
    input.filters.staleOnly,
    input.filters.status,
    input.filters.regionId,
    input.filters.updatedAfter,
    input.filters.updatedBefore,
    input.filters.minAgeDays,
    input.filters.maxAgeDays,
    input.filters.workflowRoute,
    input.page,
    input.pageSize,
    input.scope,
    input.search,
    input.sort,
    input.stageId,
  ]);

  return { data, loading, error };
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
