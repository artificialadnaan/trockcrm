import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

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

export async function updateLead(
  leadId: string,
  input: Partial<
    LeadRecord & {
      estimatedOpportunityValue: string | null;
      goDecision: "go" | "no_go" | null;
      goDecisionNotes: string | null;
      qualificationData: Record<string, unknown>;
      scopingSubsetData: Record<string, unknown>;
      disqualificationReason: string | null;
      disqualificationNotes: string | null;
    }
  >
) {
  return api<{ lead: LeadRecord }>(`/leads/${leadId}`, {
    method: "PATCH",
    json: input,
  });
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
