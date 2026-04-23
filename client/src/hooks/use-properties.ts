import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface PropertySurface {
  id: string;
  companyId: string;
  companyName: string | null;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  leadCount: number;
  dealCount: number;
  convertedDealCount: number;
  lastActivityAt: string | null;
}

export interface PropertyListFilters {
  search?: string;
  companyId?: string;
  page?: number;
  limit?: number;
  isActive?: boolean;
}

export interface PropertyLead {
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
}

export interface PropertyDeal {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  workflowRoute: "normal" | "service";
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

export interface PropertyDetailResponse {
  property: PropertySurface;
  leads: PropertyLead[];
  deals: PropertyDeal[];
}

export function formatPropertyLabel(property: Pick<PropertySurface, "name" | "address" | "city" | "state" | "zip">) {
  const line = [property.address, [property.city, property.state].filter(Boolean).join(", "), property.zip]
    .filter(Boolean)
    .join(" ");

  return line || property.name || "Unassigned Property";
}

export function useProperties(filters: PropertyListFilters = {}) {
  const [properties, setProperties] = useState<PropertySurface[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isDisabled = filters.limit === 0;

  const fetchProperties = useCallback(async () => {
    if (isDisabled) {
      setProperties([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.companyId) params.set("companyId", filters.companyId);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));
      if (filters.isActive === false) params.set("isActive", "false");

      const qs = params.toString();
      const data = await api<{ properties: PropertySurface[] }>(`/properties${qs ? `?${qs}` : ""}`);
      setProperties(data.properties);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load properties");
    } finally {
      setLoading(false);
    }
  }, [filters.companyId, filters.isActive, filters.limit, filters.page, filters.search, isDisabled]);

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);

  return { properties, loading, error, refetch: fetchProperties };
}

export function usePropertyDetail(propertyId: string | undefined) {
  const [property, setProperty] = useState<PropertyDetailResponse["property"] | null>(null);
  const [leads, setLeads] = useState<PropertyLead[]>([]);
  const [deals, setDeals] = useState<PropertyDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProperty = useCallback(async () => {
    if (!propertyId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await api<PropertyDetailResponse>(`/properties/${propertyId}`);
      setProperty(data.property);
      setLeads(data.leads);
      setDeals(data.deals);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load property");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchProperty();
  }, [fetchProperty]);

  return { property, leads, deals, loading, error, refetch: fetchProperty };
}

export async function createProperty(input: {
  companyId: string;
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  notes?: string | null;
}) {
  return api<{ property: PropertySurface }>("/properties", { method: "POST", json: input });
}
