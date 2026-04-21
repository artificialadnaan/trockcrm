import { useCallback, useEffect, useState } from "react";
import { api, resolveApiBase } from "@/lib/api";

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
  description: string | null;
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
}

export interface LeadFilters {
  search?: string;
  companyId?: string;
  propertyId?: string;
  assignedRepId?: string;
  status?: "open" | "converted" | "disqualified";
  isActive?: boolean | "all";
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
  }, [filters.assignedRepId, filters.companyId, filters.isActive, filters.propertyId, filters.search, filters.status]);

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
export async function createLead(input: {
  companyId: string;
  propertyId: string;
  stageId: string;
  assignedRepId?: string;
  name: string;
  source?: string | null;
  description?: string | null;
}) {
  return api<{ lead: LeadRecord }>("/leads", {
    method: "POST",
    json: input,
  });
}

export async function updateLead(
  leadId: string,
  input: Partial<Pick<
    LeadRecord,
    | "stageId"
    | "assignedRepId"
    | "primaryContactId"
    | "name"
    | "source"
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
  >>
) {
  return api<{ lead: LeadRecord }>(`/leads/${leadId}`, {
    method: "PATCH",
    json: input,
  });
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
  if (
    payload &&
    (response.status === 409 ||
      (typeof payload === "object" && (payload as { reason?: string }).reason === "missing_requirements"))
  ) {
    return payload as LeadTransitionResult;
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
    dealStageId: string;
    workflowRoute?: "estimating" | "service";
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
