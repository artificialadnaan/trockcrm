import { useCallback, useEffect, useState } from "react";
import { api, resolveApiBase } from "@/lib/api";
export {
  getLeadBoardStageLabel,
  getLeadStageMetadata,
  LEAD_BOARD_STAGE_SLUGS,
} from "@/lib/pipeline-ownership";
import type { StagePageQuery } from "@/lib/pipeline-stage-page";
import type { LeadScopingReadiness, LeadScopingSectionData } from "../../../shared/src/types/lead-scoping.js";
import type { LeadSourceCategory } from "../../../shared/src/types/enums.js";

export interface LeadQualificationRecord {
  id: string;
  leadId: string;
  estimatedOpportunityValue: string | null;
  goDecision: "go" | "no_go" | null;
  goDecisionNotes: string | null;
  qualificationData: Record<string, unknown>;
  scopingSubsetData: Record<string, unknown>;
  disqualificationReason: string | null;
  disqualificationNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadScopingIntakeRecord {
  id: string;
  leadId: string;
  officeId: string;
  status: "draft" | "ready" | "completed";
  sectionData: LeadScopingSectionData;
  completionState: Record<string, unknown>;
  readinessErrors: Record<string, unknown>;
  firstReadyAt: string | null;
  completedAt: string | null;
  lastAutosavedAt: string;
  createdBy: string;
  lastEditedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadStageGateResult {
  allowed: boolean;
  currentStage: { id: string; name: string; slug: string };
  targetStage: { id: string; name: string; slug: string };
  missingRequirements: {
    fields: string[];
    effectiveChecklist: {
      fields: Array<{
        key: string;
        label: string;
        satisfied: boolean;
        source: "stage";
      }>;
    };
  };
  blockReason?: string;
}

export interface LeadRecord {
  id: string;
  companyId: string;
  propertyId: string;
  primaryContactId: string | null;
  name: string;
  stageId: string;
  assignedRepId: string;
  status: "open" | "converted" | "disqualified";
  source: string | null;
  sourceCategory: LeadSourceCategory | null;
  sourceDetail: string | null;
  existingCustomerStatus?: "Existing" | "New" | null;
  description: string | null;
  projectTypeId: string | null;
  projectType: {
    id: string;
    name: string;
    slug: string;
  } | null;
  qualificationPayload: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  qualificationScope: string | null;
  qualificationBudgetAmount: string | null;
  qualificationCompanyFit: boolean | null;
  directorReviewDecision: "go" | "no_go" | null;
  directorReviewReason: string | null;
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
  lastActivityAt: string | null;
  stageEnteredAt: string;
  convertedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  companyName: string | null;
  property: {
    id: string;
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  convertedDealId: string | null;
  convertedDealNumber: string | null;
  leadQuestionnaire?: {
    projectTypeId: string | null;
    nodes: Array<{
      id: string;
      projectTypeId: string | null;
      parentNodeId: string | null;
      parentOptionValue: string | null;
      nodeType: string;
      key: string;
      label: string;
      prompt: string | null;
      inputType: string | null;
      options: unknown;
      isRequired: boolean;
      displayOrder: number;
      isActive: boolean;
    }>;
    allNodes: Array<{
      id: string;
      projectTypeId: string | null;
      parentNodeId: string | null;
      parentOptionValue: string | null;
      nodeType: string;
      key: string;
      label: string;
      prompt: string | null;
      inputType: string | null;
      options: unknown;
      isRequired: boolean;
      displayOrder: number;
      isActive: boolean;
    }>;
    answers: Record<string, string | boolean | number | null>;
  };
}

export interface LeadQuestionnaireSnapshot {
  projectTypeId: string | null;
  nodes: Array<{
    id: string;
    projectTypeId: string | null;
    parentNodeId: string | null;
    parentOptionValue: string | null;
    nodeType: string;
    key: string;
    label: string;
    prompt: string | null;
    inputType: string | null;
    options: unknown;
    isRequired: boolean;
    displayOrder: number;
    isActive: boolean;
  }>;
  allNodes: Array<{
    id: string;
    projectTypeId: string | null;
    parentNodeId: string | null;
    parentOptionValue: string | null;
    nodeType: string;
    key: string;
    label: string;
    prompt: string | null;
    inputType: string | null;
    options: unknown;
    isRequired: boolean;
    displayOrder: number;
    isActive: boolean;
  }>;
  answers: Record<string, string | boolean | number | null>;
}

export interface LeadFilters {
  search?: string;
  companyId?: string;
  propertyId?: string;
  assignedRepId?: string;
  status?: "open" | "converted" | "disqualified";
  isActive?: boolean | "all";
}

export interface LeadBoardStage {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  displayOrder?: number;
  isActivePipeline?: boolean;
  isTerminal?: boolean;
}

export interface LeadBoardCard {
  id: string;
  name: string;
  stageId: string;
  assignedRepId?: string;
  officeId?: string;
  companyName?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  source?: string | null;
  status?: string;
  lastActivityAt?: string | null;
  stageEnteredAt: string;
  updatedAt: string;
}

export interface LeadBoardResponse {
  columns: Array<{
    stage: LeadBoardStage;
    count: number;
    cards: LeadBoardCard[];
  }>;
  defaultConversionDealStageId: string | null;
}

export interface LeadStagePageResponse {
  stage: LeadBoardStage;
  scope: "mine" | "team" | "all";
  summary: { count: number };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  rows: LeadBoardCard[];
}

export function formatLeadPropertyLine(lead: Pick<LeadRecord, "property">) {
  const property = lead.property;
  if (!property) return "";
  return [property.address, [property.city, property.state].filter(Boolean).join(", "), property.zip]
    .filter(Boolean)
    .join(" ");
}

export function useLeads(filters: LeadFilters = {}) {
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.companyId) params.set("companyId", filters.companyId);
      if (filters.propertyId) params.set("propertyId", filters.propertyId);
      if (filters.assignedRepId) params.set("assignedRepId", filters.assignedRepId);
      if (filters.status) params.set("status", filters.status);
      if (filters.isActive === "all") params.set("isActive", "all");
      else if (filters.isActive === false) params.set("isActive", "false");

      const qs = params.toString();
      const data = await api<{ leads: LeadRecord[] }>(`/leads${qs ? `?${qs}` : ""}`);
      setLeads(data.leads);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load leads");
    } finally {
      setLoading(false);
    }
  }, [
    filters.assignedRepId,
    filters.companyId,
    filters.isActive,
    filters.propertyId,
    filters.search,
    filters.status,
  ]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  return { leads, loading, error, refetch: fetchLeads };
}

export function useLeadDetail(leadId: string | undefined) {
  const [lead, setLead] = useState<LeadRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLead = useCallback(async () => {
    if (!leadId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<{ lead: LeadRecord }>(`/leads/${leadId}`);
      setLead(data.lead);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load lead");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    fetchLead();
  }, [fetchLead]);

  return { lead, loading, error, refetch: fetchLead };
}

export function useLeadQuestionnaireTemplate(projectTypeId: string | null | undefined) {
  const [questionnaire, setQuestionnaire] = useState<LeadQuestionnaireSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchQuestionnaire = useCallback(async () => {
    const params = new URLSearchParams();
    if (projectTypeId) {
      params.set("projectTypeId", projectTypeId);
    }

    setLoading(true);
    try {
      const data = await api<{
        enabled: boolean;
        questionnaire: LeadQuestionnaireSnapshot | null;
      }>(`/leads/questionnaire-template${params.toString() ? `?${params.toString()}` : ""}`);
      setQuestionnaire(data.enabled ? data.questionnaire : null);
    } catch {
      setQuestionnaire(null);
    } finally {
      setLoading(false);
    }
  }, [projectTypeId]);

  useEffect(() => {
    fetchQuestionnaire();
  }, [fetchQuestionnaire]);

  return { questionnaire, loading, refetch: fetchQuestionnaire };
}

export function useLeadQualification(leadId: string | undefined) {
  const [qualification, setQualification] = useState<LeadQualificationRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQualification = useCallback(async () => {
    if (!leadId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<{ qualification: LeadQualificationRecord | null }>(
        `/leads/${leadId}/qualification`
      );
      setQualification(data.qualification);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load lead qualification");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    fetchQualification();
  }, [fetchQualification]);

  return { qualification, loading, error, refetch: fetchQualification };
}

export function useLeadScoping(leadId: string | undefined) {
  const [intake, setIntake] = useState<LeadScopingIntakeRecord | null>(null);
  const [readiness, setReadiness] = useState<LeadScopingReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchScoping = useCallback(async () => {
    if (!leadId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<{
        intake: LeadScopingIntakeRecord | null;
        readiness: LeadScopingReadiness;
      }>(`/leads/${leadId}/scoping`);
      setIntake(data.intake);
      setReadiness(data.readiness);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load lead scoping");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    fetchScoping();
  }, [fetchScoping]);

  return { intake, readiness, loading, error, refetch: fetchScoping };
}

export async function createLead(input: {
  companyId: string;
  propertyId: string;
  stageId: string;
  assignedRepId?: string;
  primaryContactId?: string | null;
  name: string;
  source?: string | null;
  sourceCategory?: LeadSourceCategory | null;
  sourceDetail?: string | null;
  description?: string | null;
  projectTypeId?: string | null;
  qualificationPayload?: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  leadQuestionAnswers?: Record<string, string | boolean | number | null>;
}) {
  return api<{ lead: LeadRecord }>("/leads", {
    method: "POST",
    json: input,
  });
}

type LeadUpdatePayload = Partial<
  Pick<
    LeadRecord,
    | "stageId"
    | "assignedRepId"
    | "primaryContactId"
    | "name"
    | "source"
    | "sourceCategory"
    | "sourceDetail"
    | "description"
    | "status"
    | "decisionMakerName"
    | "decisionProcess"
    | "budgetStatus"
    | "incumbentVendor"
    | "unitCount"
    | "buildYear"
    | "forecastWindow"
    | "forecastCategory"
    | "forecastConfidencePercent"
    | "forecastRevenue"
    | "forecastGrossProfit"
    | "forecastBlockers"
    | "nextStep"
    | "nextStepDueAt"
    | "nextMilestoneAt"
    | "supportNeededType"
    | "supportNeededNotes"
    | "projectTypeId"
    | "qualificationScope"
    | "qualificationBudgetAmount"
    | "qualificationCompanyFit"
    | "directorReviewDecision"
    | "directorReviewReason"
  > & {
    qualificationPayload: Record<string, string | boolean | number | null>;
    projectTypeQuestionPayload: {
      projectTypeId: string | null;
      answers: Record<string, string | boolean | number | null>;
    };
    estimatedOpportunityValue: string | null;
    goDecision: "go" | "no_go" | null;
    goDecisionNotes: string | null;
    qualificationData: Record<string, unknown>;
    scopingSubsetData: Record<string, unknown>;
    disqualificationReason: string | null;
    disqualificationNotes: string | null;
    leadQuestionAnswers: Record<string, string | boolean | number | null>;
  }
>;

export async function updateLead(leadId: string, input: LeadUpdatePayload) {
  return api<{ lead: LeadRecord }>(`/leads/${leadId}`, {
    method: "PATCH",
    json: input,
  });
}

export async function updateLeadScoping(
  leadId: string,
  input: { sectionData: LeadScopingSectionData }
) {
  return api<{ intake: LeadScopingIntakeRecord | null; readiness: LeadScopingReadiness }>(
    `/leads/${leadId}/scoping`,
    {
      method: "PATCH",
      json: input,
    }
  );
}

export interface LeadTransitionMissingRequirement {
  key: string;
  label: string;
  resolution: "inline" | "detail";
}

export type LeadTransitionResult =
  | { ok: true; lead: LeadRecord }
  | {
      ok: false;
      reason: "missing_requirements";
      targetStageId: string;
      resolution: "inline";
      missing: LeadTransitionMissingRequirement[];
    };

function normalizeBlockedLeadTransitionPayload(
  payload: unknown,
  targetStageId: string
): LeadTransitionResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if ((payload as { reason?: string }).reason === "missing_requirements") {
    return payload as LeadTransitionResult;
  }

  const errorPayload = (payload as {
    error?: {
      code?: string;
      missingRequirements?: {
        prerequisiteFields?: string[];
        qualificationFields?: string[];
        projectTypeQuestionIds?: string[];
      };
    };
  }).error;

  if (errorPayload?.code !== "LEAD_STAGE_REQUIREMENTS_UNMET") {
    return null;
  }

  const requirementKeys = [
    ...(errorPayload.missingRequirements?.prerequisiteFields ?? []),
    ...(errorPayload.missingRequirements?.qualificationFields ?? []),
    ...(errorPayload.missingRequirements?.projectTypeQuestionIds ?? []),
  ];

  return {
    ok: false,
    reason: "missing_requirements",
    targetStageId,
    resolution: "inline",
    missing: requirementKeys.map((key) => ({
      key,
      label: key,
      resolution: "inline",
    })),
  };
}

export type LeadTransitionInlinePatch = Partial<
  Pick<
    LeadRecord,
    | "source"
    | "description"
    | "qualificationScope"
    | "qualificationBudgetAmount"
    | "qualificationCompanyFit"
    | "directorReviewDecision"
    | "directorReviewReason"
  >
>;

const LEADS_API_BASE = resolveApiBase(
  (import.meta as any).env ?? {},
  typeof window !== "undefined" ? window.location : undefined
);

export async function transitionLeadStage(
  leadId: string,
  input: {
    targetStageId: string;
    inlinePatch?: LeadTransitionInlinePatch;
  }
) {
  const response = await fetch(`${LEADS_API_BASE}/leads/${leadId}/stage-transition`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(input),
  });

  const payload = await response.json().catch(() => null);
  const blockedMove = normalizeBlockedLeadTransitionPayload(payload, input.targetStageId);
  if (blockedMove) {
    return blockedMove;
  }

  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload as LeadTransitionResult;
}

export async function convertLead(
  leadId: string,
  input: {
    dealStageId?: string;
    workflowRoute?: "normal" | "service";
    assignedRepId?: string;
    primaryContactId?: string | null;
    name?: string;
    source?: string | null;
    description?: string | null;
    ddEstimate?: string | null;
    bidEstimate?: string | null;
    awardedAmount?: string | null;
    projectTypeId?: string | null;
    regionId?: string | null;
    expectedCloseDate?: string | null;
  }
) {
  return api<{ lead: LeadRecord; deal: { id: string } }>(`/leads/${leadId}/convert`, {
    method: "POST",
    json: input,
  });
}

export function useLeadBoard(scope: "mine" | "team" | "all") {
  const [board, setBoard] = useState<LeadBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return api<LeadBoardResponse>(`/leads/board?scope=${scope}&previewLimit=8`)
      .then((result) => {
        setBoard(result);
        return result;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load lead board");
        throw err;
      })
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(() => {
    void refetch().catch(() => undefined);
  }, [refetch]);

  async function convertLeadFromBoard(input: {
    leadId: string;
    dealStageId?: string;
    workflowRoute?: "normal" | "service";
    assignedRepId?: string;
    primaryContactId?: string | null;
    name?: string;
    source?: string | null;
    description?: string | null;
    ddEstimate?: string | null;
    bidEstimate?: string | null;
    awardedAmount?: string | null;
    projectTypeId?: string | null;
    regionId?: string | null;
    expectedCloseDate?: string | null;
  }) {
    const { leadId, ...rest } = input;
    return convertLead(leadId, rest);
  }

  return { board, loading, error, convertLead: convertLeadFromBoard, refetch };
}

export function useLeadStagePage(
  input: StagePageQuery & { stageId: string; scope: "mine" | "team" | "all" }
) {
  const [data, setData] = useState<LeadStagePageResponse | null>(null);
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
    });

    setLoading(true);
    setError(null);
    setData(null);

    void api<LeadStagePageResponse>(`/leads/stages/${input.stageId}?${params.toString()}`)
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

export async function updateLeadStage(leadId: string, stageId: string) {
  return api(`/leads/${leadId}`, { method: "PATCH", json: { stageId } });
}

export async function preflightLeadStageCheck(leadId: string, targetStageId: string) {
  return api<LeadStageGateResult>(`/leads/${leadId}/stage/preflight`, {
    method: "POST",
    json: { targetStageId },
  });
}

export async function convertLeadToOpportunity(leadId: string) {
  return api<{ lead: LeadRecord; deal: { id: string } }>(`/leads/${leadId}/convert`, {
    method: "POST",
  });
}
