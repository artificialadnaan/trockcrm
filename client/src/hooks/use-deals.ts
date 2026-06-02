import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions, type OfficeRequestOptions } from "@/lib/office-selection";
import {
  appendPipelineTerminalDateParams,
  type TerminalDateFilter,
  type TerminalOutcome,
} from "@/lib/pipeline-terminal-filters";
import type { FileRecord } from "./use-files";
import type { StagePageQuery } from "@/lib/pipeline-stage-page";
import type { AtRiskResult } from "@trock-crm/shared/types";
export { getDealStageMetadata, getWorkflowRouteLabel } from "@/lib/pipeline-ownership";

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

export interface Deal {
  id: string;
  dealNumber: string;
  projectNumber?: string | null;
  name: string;
  stageId: string;
  pipelineDisposition: DealPipelineDisposition;
  workflowRoute: WorkflowRoute | null;
  assignedRepId: string;
  assignedRepName?: string | null;
  companyId: string | null;
  companyName?: string | null;
  companyOwnerUserId?: string | null;
  companyOwnerUserName?: string | null;
  propertyId: string | null;
  sourceLeadId: string | null;
  primaryContactId: string | null;
  primaryContactName?: string | null;
  primaryContactTitle?: string | null;
  primaryContactOwnerUserId?: string | null;
  primaryContactOwnerUserName?: string | null;
  ddEstimate: string | null;
  bidEstimate: string | null;
  awardedAmount: string | null;
  changeOrderTotal: string | null;
  description: string | null;
  estimator?: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  propertyCountry?: string | null;
  officeCode?: string | null;
  projectType?: string | null;
  projectTypeId: string | null;
  bidBoardProjectNumber?: string | null;
  bidBoardLinkedAt?: string | null;
  intendedProjectNumber?: string | null;
  regionId: string | null;
  isReadOnlyMirror?: boolean;
  source: string | null;
  winProbability: number | null;
  emailCount?: number;
  lastEmailAt?: string | null;
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
  procoreCompanyId?: string | null;
  procoreBidId: number | null;
  procoreLastSyncedAt: string | null;
  isBidBoardOwned: boolean;
  bidBoardStageSlug: string | null;
  bidBoardStageEnteredAt?: string | null;
  bidBoardMirrorSourceEnteredAt?: string | null;
  bidBoardStatus?: string | null;
  bidBoardTotalSales?: string | null;
  bidBoardLastUpdatedAt?: string | null;
  bidBoardAssignedPm?: string | null;
  readOnlySyncedAt: string | null;
  lostReasonId: string | null;
  lostNotes: string | null;
  lostCompetitor: string | null;
  lostAt: string | null;
  expectedCloseDate: string | null;
  actualCloseDate: string | null;
  // Outcome-aware display date (Won->signed, Lost->lost, open->stage-entry) selected server-side by
  // P0's dealDisplayDateExpr so the date a surface SHOWS matches the date it FILTERS on. Absent until
  // the platform date audit wires the SELECT; getDealDisplayDate falls back to the close-date chain.
  displayDate?: string | null;
  onHold?: boolean;
  onHoldStartedAt?: string | null;
  onHoldAccumulatedSeconds?: number | null;
  onHoldAccumulatedSecondsAtStageEntry?: number | null;
  contractSignedAt?: string | null;
  contractSignedDate: string | null;
  rfpApprovalRequestedAt?: string | null;
  rfpApprovalRequestId?: number | null;
  rfpApprovalToken?: string | null;
  rfpApprovalStatus?:
    | "pending_outbox"
    | "pending"
    | "approved"
    | "declined"
    | "conflict"
    | "cancelled_source_ineligible"
    | "send_failed"
    | null;
  rfpConflictReason?: string | null;
  rfpConflictWith?: Record<string, unknown> | null;
  rfpLastAttemptError?: string | null;
  rfpDeclinedReason?: string | null;
  rfpDeclinedAt?: string | null;
  isRfpTriggerEnabled?: boolean;
  lastActivityAt: string | null;
  stageEnteredAt: string;
  stageName?: string | null;
  stageSlug?: string | null;
  isActive: boolean;
  // The raw HubSpot ID is stripped from the default API response (only admins
  // see it via ?includeHubspotId=true). Client gates and display logic should
  // branch on `isHubspotSourced` instead, which is derived server-side from
  // `hubspot_id IS NOT NULL` and always present on the wire.
  hubspotDealId?: string | null;
  isHubspotSourced: boolean;
  createdAt: string;
  updatedAt: string;
  isWatching?: boolean;
  atRisk?: AtRiskResult | null;
}

export interface DealDetail extends Deal {
  proposalStatus: string | null;
  proposalDraftStartedAt: string | null;
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
  inactiveStageIds?: string[];
  assignedRepId?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  isActive?: boolean | "all" | "pipeline";
  contractSignedFrom?: string;
  contractSignedTo?: string;
  wonClosedFrom?: string;
  wonClosedTo?: string;
  estimateSentFrom?: string;
  estimateSentTo?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  // Shared FilterBar (#546) dimensions. dateFrom/dateTo are the outcome-aware window (one window,
  // three axes server-side); status owns is_active/on_hold (do NOT also send isActive); the rest are
  // additive predicates BLUE adds to getDeals. Absent key = no filter.
  dateFrom?: string;
  dateTo?: string;
  // D-15: force the outcome window to bound OPEN rows on stage_entered_at regardless of
  // the server's ENABLE_STAGE_ENTRY_DATE_FILTER flag (the rep drill-down sets this).
  stageEntryDateWindow?: boolean;
  // Exclude on-hold (migration parking-lot) deals, matching the Won board/summary. The Won stage-page /
  // drill-down list sets this so it reconciles to the Won count; other surfaces omit it.
  excludeOnHold?: boolean;
  status?: "active" | "on_hold" | "inactive" | "any";
  workflowRoute?: "normal" | "service";
  valueMin?: number;
  valueMax?: number;
  minAgeDays?: number;
  maxAgeDays?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
  scope?: "mine" | "team" | "all";
  /** Opt-in: also request pagination.valueTotal (the running-total card, #4). Only the surfaces
   *  that show the Total card set this, so plain list calls don't pay for the extra aggregate. */
  includeValueTotal?: boolean;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  activeCount?: number;
  totalPages: number;
  /**
   * The summed effective deal value of the ENTIRE filtered set (all pages), computed server-side
   * over the same WHERE as `total` (SUM of the stage-aware effective value — Won awarded-first,
   * else best-estimate; on_hold ⇒ 0; test data excluded). Drives the running-total card (#4) so
   * the total can never disagree with the list it totals. Absent on legacy/older responses.
   */
  valueTotal?: number;
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
  activeCount?: number;
  totalCount?: number;
  totalValue: number;
  cards: Deal[];
}

export interface DealBoardResponse {
  columns: DealBoardColumn[];
  terminalStages: Array<{
    stage: DealBoardColumn["stage"];
    count: number;
    activeCount?: number;
    totalCount?: number;
    totalValue?: number;
    deals?: Deal[];
  }>;
}

export interface DealStagePageResponse {
  stage: DealBoardColumn["stage"];
  scope: "mine" | "team" | "all";
  summary: {
    count: number;
    activeCount?: number;
    totalCount?: number;
    totalValue: number;
    averageDaysInStage: number | null;
  };
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
    activeCount?: number;
    totalCount?: number;
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
      activeCount: sourceColumn.activeCount ?? sourceColumn.count,
      totalCount: sourceColumn.totalCount ?? sourceColumn.count,
      cards: sourceColumn.cards ?? sourceColumn.deals ?? [],
    };
  });

  return {
    columns: normalizedColumns,
    terminalStages: (result.terminalStages ?? []).map((terminal) => ({
      ...terminal,
      activeCount: terminal.activeCount ?? terminal.count,
      totalCount: terminal.totalCount ?? terminal.count,
      totalValue: terminal.totalValue ?? 0,
    })),
  };
}

/**
 * DealFilters -> GET /api/deals query string. Pure (no hook state) so it is unit-testable. For
 * legacy callers (no FilterBar dimensions set) the output is byte-identical to the prior inline
 * serialization. New FilterBar (#546) params (dateFrom/dateTo/status/workflowRoute/value/age) are
 * appended only when set; `status` (when not "any") suppresses the legacy `isActive` per contract
 * §5 — Status owns is_active/on_hold, so we send one or the other, never both.
 */
export function buildDealsQueryParams(filters: DealFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.stageIds?.length) params.set("stageIds", filters.stageIds.join(","));
  if (filters.inactiveStageIds?.length) params.set("inactiveStageIds", filters.inactiveStageIds.join(","));
  if (filters.assignedRepId) params.set("assignedRepId", filters.assignedRepId);
  if (filters.projectTypeId) params.set("projectTypeId", filters.projectTypeId);
  if (filters.regionId) params.set("regionId", filters.regionId);
  if (filters.source) params.set("source", filters.source);
  if (filters.contractSignedFrom) params.set("contractSignedFrom", filters.contractSignedFrom);
  if (filters.contractSignedTo) params.set("contractSignedTo", filters.contractSignedTo);
  if (filters.wonClosedFrom) params.set("wonClosedFrom", filters.wonClosedFrom);
  if (filters.wonClosedTo) params.set("wonClosedTo", filters.wonClosedTo);
  if (filters.estimateSentFrom) params.set("estimateSentFrom", filters.estimateSentFrom);
  if (filters.estimateSentTo) params.set("estimateSentTo", filters.estimateSentTo);
  if (filters.createdFrom) params.set("createdFrom", filters.createdFrom);
  if (filters.createdTo) params.set("createdTo", filters.createdTo);
  if (filters.updatedFrom) params.set("updatedFrom", filters.updatedFrom);
  if (filters.updatedTo) params.set("updatedTo", filters.updatedTo);
  const hasStatus = filters.status !== undefined && filters.status !== "any";
  if (hasStatus) params.set("status", filters.status as string);
  if (filters.isActive !== undefined && !hasStatus) params.set("isActive", String(filters.isActive));
  if (filters.sortBy) params.set("sortBy", filters.sortBy);
  if (filters.sortDir) params.set("sortDir", filters.sortDir);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.scope) params.set("scope", filters.scope);
  // FilterBar (#546) dimensions — appended; absent unless set, so legacy callers are unaffected.
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.stageEntryDateWindow) params.set("stage_entry_window", "true");
  if (filters.excludeOnHold) params.set("exclude_on_hold", "true");
  if (filters.workflowRoute) params.set("workflowRoute", filters.workflowRoute);
  if (filters.valueMin !== undefined) params.set("valueMin", String(filters.valueMin));
  if (filters.valueMax !== undefined) params.set("valueMax", String(filters.valueMax));
  if (filters.minAgeDays !== undefined) params.set("minAgeDays", String(filters.minAgeDays));
  if (filters.maxAgeDays !== undefined) params.set("maxAgeDays", String(filters.maxAgeDays));
  if (filters.includeValueTotal) params.set("includeValueTotal", "true");
  return params;
}

export function useDeals(filters: DealFilters = {}, options: { enabled?: boolean } = {}) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const enabled = options.enabled ?? true;
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchDeals = useCallback(async () => {
    if (!enabled) {
      requestIdRef.current += 1;
      setLoading(false);
      setError(null);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const qs = buildDealsQueryParams(filters).toString();
      const data = await api<{ deals: Deal[]; pagination: Pagination }>(
        `/deals${qs ? `?${qs}` : ""}`
      );
      if (requestId !== requestIdRef.current) return;
      setDeals(data.deals);
      setPagination(data.pagination);
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load deals");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [
    filters.search,
    filters.stageIds?.join(","),
    filters.inactiveStageIds?.join(","),
    filters.assignedRepId,
    filters.projectTypeId,
    filters.regionId,
    filters.source,
    filters.contractSignedFrom,
    filters.contractSignedTo,
    filters.wonClosedFrom,
    filters.wonClosedTo,
    filters.estimateSentFrom,
    filters.estimateSentTo,
    filters.createdFrom,
    filters.createdTo,
    filters.updatedFrom,
    filters.updatedTo,
    filters.dateFrom,
    filters.dateTo,
    filters.stageEntryDateWindow,
    filters.excludeOnHold,
    filters.status,
    filters.workflowRoute,
    filters.valueMin,
    filters.valueMax,
    filters.minAgeDays,
    filters.maxAgeDays,
    filters.isActive,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.limit,
    filters.scope,
    filters.includeValueTotal,
    enabled,
  ]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, pagination, loading, error, refetch: fetchDeals };
}

export function useDealDetail(dealId: string | undefined, options: OfficeRequestOptions = {}) {
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
      const data = await api<{ deal: DealDetail }>(`/deals/${dealId}/detail`, {
        ...getOfficeRequestOptions(options.officeId),
      });
      setDeal(data.deal);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deal");
    } finally {
      setLoading(false);
    }
  }, [dealId, options.officeId]);

  useEffect(() => {
    fetchDeal();
  }, [fetchDeal]);

  return { deal, loading, error, refetch: fetchDeal };
}

export async function createDeal(input: Partial<Deal> & { name: string; stageId: string }, options: OfficeRequestOptions = {}) {
  return api<{ deal: Deal }>("/deals", {
    method: "POST",
    json: input,
    ...getOfficeRequestOptions(options.officeId),
  });
}

export type CreateServiceOpportunityInput = Partial<Pick<
  Deal,
  | "assignedRepId"
  | "companyId"
  | "description"
  | "expectedCloseDate"
  | "officeCode"
  | "projectNumber"
  | "projectType"
  | "projectTypeId"
  | "propertyId"
  | "source"
  | "winProbability"
>> & { name: string };

export async function createServiceOpportunity(
  input: CreateServiceOpportunityInput,
  options: OfficeRequestOptions = {}
) {
  return api<{ deal: Deal }>("/deals/service-opportunity", {
    method: "POST",
    json: input,
    ...getOfficeRequestOptions(options.officeId),
  });
}

export type UpdateDealPayload = Partial<Deal> & {
  migrationMode?: boolean;
};

export async function updateDeal(dealId: string, input: UpdateDealPayload) {
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
    expectedCloseDate?: string;
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
    targetStage: { id: string; name: string; slug: string; isTerminal: boolean; isActivePipeline: boolean };
    currentStage: { id: string; name: string; slug: string; isTerminal: boolean; isActivePipeline: boolean };
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
    forceEditAfterRfp: boolean;
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
  input: Partial<Record<keyof DealResolvedFields | "preBidMeetingCompleted" | "siteVisitDecision" | "siteVisitCompleted" | "estimatorConsultationNotes" | "forceEditAfterRfp", unknown>>
) {
  return api<{ resolved: { deal?: DealDetail; resolved: DealResolvedFields } }>(`/deals/${dealId}/resolved-fields`, {
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

export function useDealBoard(
  scope: "mine" | "team" | "all",
  includeDd: boolean,
  terminalDateFilters?: Record<TerminalOutcome, TerminalDateFilter>,
  previewLimit: number | null = 8,
  wonPeriodRange?: { from?: string; to?: string } | null,
  assignedRepId?: string,
  estimateSentDateRange?: { from?: string; to?: string }
) {
  const [board, setBoard] = useState<DealBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      scope,
      includeDd: String(includeDd),
    });
    if (previewLimit !== null) {
      params.set("previewLimit", String(previewLimit));
    }
    if (terminalDateFilters) {
      appendPipelineTerminalDateParams(params, terminalDateFilters);
    }
    if (wonPeriodRange?.from) {
      params.set("won_period_from", wonPeriodRange.from);
    }
    if (wonPeriodRange?.to) {
      params.set("won_period_to", wonPeriodRange.to);
    }
    if (assignedRepId) {
      params.set("assignedRepId", assignedRepId);
    }
    if (estimateSentDateRange?.from) {
      params.set("estimateSentFrom", estimateSentDateRange.from);
    }
    if (estimateSentDateRange?.to) {
      params.set("estimateSentTo", estimateSentDateRange.to);
    }
    return api<DealBoardApiResponse>(`/deals/pipeline?${params.toString()}`)
      .then((result) => {
        const normalized = normalizeDealBoardResponse(result);
        setBoard(normalized);
        return normalized;
      })
      .catch((err: unknown) => {
        setBoard(null);
        setError(err instanceof Error ? err.message : "Failed to load deal board");
        throw err;
      })
      .finally(() => setLoading(false));
  }, [
    assignedRepId,
    estimateSentDateRange?.from,
    estimateSentDateRange?.to,
    includeDd,
    previewLimit,
    scope,
    terminalDateFilters,
    wonPeriodRange?.from,
    wonPeriodRange?.to,
  ]);

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
      ...(input.filters.estimateSentFrom ? { estimateSentFrom: input.filters.estimateSentFrom } : {}),
      ...(input.filters.estimateSentTo ? { estimateSentTo: input.filters.estimateSentTo } : {}),
      ...(input.filters.staleOnly ? { staleOnly: "true" } : {}),
      ...(input.filters.status ? { status: input.filters.status } : {}),
      ...(input.filters.workflowRoute ? { workflowRoute: input.filters.workflowRoute } : {}),
      ...(input.filters.source ? { source: input.filters.source } : {}),
      ...(input.filters.regionId ? { regionId: input.filters.regionId } : {}),
      ...(input.filters.updatedAfter ? { updatedAfter: input.filters.updatedAfter } : {}),
      ...(input.filters.updatedBefore ? { updatedBefore: input.filters.updatedBefore } : {}),
      ...(input.filters.minAgeDays ? { minAgeDays: input.filters.minAgeDays } : {}),
      ...(input.filters.maxAgeDays ? { maxAgeDays: input.filters.maxAgeDays } : {}),
      ...(input.filters.wonSince ? { won_since: input.filters.wonSince } : {}),
      ...(input.filters.wonUntil ? { won_until: input.filters.wonUntil } : {}),
      ...(input.filters.wonAllTime ? { won_all_time: "true" } : {}),
      ...(input.filters.lostSince ? { lost_since: input.filters.lostSince } : {}),
      ...(input.filters.lostUntil ? { lost_until: input.filters.lostUntil } : {}),
      ...(input.filters.lostAllTime ? { lost_all_time: "true" } : {}),
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
    input.filters.estimateSentFrom,
    input.filters.estimateSentTo,
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
    forceEditAfterRfp?: boolean;
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
