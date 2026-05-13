import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions, type OfficeRequestOptions } from "@/lib/office-selection";

export interface PropertySurface {
  id: string;
  companyId: string;
  companyName: string | null;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  type?: string | null;
  propertyType?: string | null;
  buildYear: number | null;
  unitCount: number | null;
  lat?: number | null;
  lng?: number | null;
  floors?: number | null;
  roofArea?: number | null;
  notes: string | null;
  procoreId?: string | null;
  procorePropertyId?: string | null;
  companycamId?: string | null;
  companycamProjectId?: string | null;
  hubspotPropertyId?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  leadCount: number;
  dealCount: number;
  convertedDealCount: number;
  lastActivityAt: string | null;
  engagementStatus?: "active_deal" | "active_lead" | "won" | "no_engagement";
  linkedValue?: string;
  activePipelineValue?: string;
  photosCount?: number;
}

export interface PropertyListFilters {
  search?: string;
  companyId?: string;
  type?: string;
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
  // Stripped from the default API response; gates use isHubspotSourced.
  hubspotDealId?: string | null;
  isHubspotSourced: boolean;
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

export function useProperties(filters: PropertyListFilters = {}, options: OfficeRequestOptions = {}) {
  const [properties, setProperties] = useState<PropertySurface[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isDisabled = filters.limit === 0;
  const requestRef = useRef(0);

  const fetchProperties = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (isDisabled) {
      setProperties([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setProperties([]);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.companyId) params.set("companyId", filters.companyId);
      if (filters.type) params.set("type", filters.type);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));
      if (filters.isActive === false) params.set("isActive", "false");

      const qs = params.toString();
      const data = await api<{ properties: PropertySurface[] }>(
        `/properties${qs ? `?${qs}` : ""}`,
        getOfficeRequestOptions(options.officeId)
      );
      if (requestId !== requestRef.current) return;
      setProperties(data.properties);
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load properties");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, [filters.companyId, filters.isActive, filters.limit, filters.page, filters.search, filters.type, isDisabled, options.officeId]);

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);

  return { properties, loading, error, refetch: fetchProperties };
}

export function usePropertyDetail(propertyId: string | undefined, options: OfficeRequestOptions = {}) {
  const [property, setProperty] = useState<PropertyDetailResponse["property"] | null>(null);
  const [leads, setLeads] = useState<PropertyLead[]>([]);
  const [deals, setDeals] = useState<PropertyDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const fetchProperty = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!propertyId) {
      setProperty(null);
      setLeads([]);
      setDeals([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setProperty(null);
    setLeads([]);
    setDeals([]);
    try {
      const data = await api<PropertyDetailResponse>(
        `/properties/${propertyId}`,
        getOfficeRequestOptions(options.officeId)
      );
      if (requestId !== requestRef.current) return;
      setProperty(data.property);
      setLeads(data.leads);
      setDeals(data.deals);
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load property");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, [propertyId, options.officeId]);

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
  buildYear?: number | null;
  unitCount?: number | null;
  notes?: string | null;
}, options: OfficeRequestOptions = {}) {
  return api<{ property: PropertySurface }>("/properties", {
    method: "POST",
    json: input,
    ...getOfficeRequestOptions(options.officeId),
  });
}

export async function updateProperty(
  propertyId: string,
  input: {
    buildYear?: number | null;
    unitCount?: number | null;
  },
  options: OfficeRequestOptions = {}
) {
  return api<{ property: PropertySurface }>(`/properties/${propertyId}`, {
    method: "PATCH",
    json: input,
    ...getOfficeRequestOptions(options.officeId),
  });
}
