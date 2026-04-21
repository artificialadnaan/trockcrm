import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { StagePageQuery } from "@/lib/pipeline-stage-page";

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

export function useLeadBoard(scope: "mine" | "team" | "all") {
  const [board, setBoard] = useState<LeadBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    setLoading(true);
    return api<LeadBoardResponse>(`/leads/board?scope=${scope}`)
      .then((result) => {
        setBoard(result);
        return result;
      })
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function convertLead(input: {
    leadId: string;
    dealStageId: string;
    workflowRoute: "estimating" | "service";
  }) {
    return api(`/leads/${input.leadId}/convert`, { method: "POST", json: input });
  }

  return { board, loading, convertLead, refetch };
}

export function useLeadStagePage(input: StagePageQuery & { stageId: string; scope: "mine" | "team" | "all" }) {
  const [data, setData] = useState<LeadStagePageResponse | null>(null);

  useEffect(() => {
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
    });

    void api<LeadStagePageResponse>(`/leads/stages/${input.stageId}?${params.toString()}`).then(setData);
  }, [
    input.filters.assignedRepId,
    input.filters.source,
    input.filters.staleOnly,
    input.filters.status,
    input.filters.workflowRoute,
    input.page,
    input.pageSize,
    input.scope,
    input.search,
    input.sort,
    input.stageId,
  ]);

  return { data };
}

export async function updateLeadStage(leadId: string, stageId: string) {
  return api(`/leads/${leadId}`, { method: "PATCH", json: { stageId } });
}
