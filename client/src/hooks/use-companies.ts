import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { getOfficeRequestOptions, type OfficeRequestOptions } from "@/lib/office-selection";

export interface Company {
  id: string;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  website: string | null;
  ownerUserId?: string | null;
  ownerUserName?: string | null;
  industry?: string | null;
  region?: string | null;
  domain?: string | null;
  lastActivityAt?: string | null;
  emailCount?: number;
  lastEmailAt?: string | null;
  hubspotId?: string | null;
  hubspotCompanyId?: string | null;
  procoreId?: string | null;
  notes: string | null;
  companyVerificationStatus: "pending" | "verified" | "not_required" | null;
  companyVerificationRequestedAt: string | null;
  companyVerificationEmailSentAt: string | null;
  companyVerifiedAt: string | null;
  companyVerifiedBy: string | null;
  contactCount: number;
  dealCount: number;
  propertiesCount?: number;
  contactsCount?: number;
  activeDealsCount?: number;
  pipelineValue?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyFilters {
  search?: string;
  category?: string;
  industry?: string;
  ownerScope?: "mine";
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useCompanies(filters: CompanyFilters = {}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Last-write-wins: a search/filter/page change can leave an earlier request in flight, and
  // debounce reduces but does not eliminate out-of-order responses on fast typing. Only the
  // latest request may write results, so a slow earlier response cannot overwrite a later one.
  const requestIdRef = useRef(0);

  const fetchCompanies = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.category) params.set("category", filters.category);
      if (filters.industry) params.set("industry", filters.industry);
      if (filters.ownerScope === "mine") params.set("ownerScope", "mine");
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ companies: Company[]; total: number; page: number; limit: number }>(
        `/companies${qs ? `?${qs}` : ""}`
      );
      if (requestId !== requestIdRef.current) return; // a newer request superseded this one
      setCompanies(data.companies);
      const total = data.total;
      const page = data.page ?? filters.page ?? 1;
      const limit = data.limit ?? filters.limit ?? 50;
      setPagination({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load companies");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [filters.search, filters.category, filters.industry, filters.ownerScope, filters.page, filters.limit]);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  return { companies, pagination, loading, error, refetch: fetchCompanies };
}

export function assignCompanyOwnerToMe(companyId: string) {
  return api<{ company: Company }>(`/companies/${companyId}/assign-to-me`, {
    method: "POST",
  });
}

export function reassignCompanyOwner(companyId: string, ownerUserId: string | null) {
  return api<{ company: Company }>(`/companies/${companyId}/owner`, {
    method: "PATCH",
    json: { ownerUserId },
  });
}

export function useCompanyDetail(companyId: string | undefined, options: OfficeRequestOptions = {}) {
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const fetchCompany = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!companyId) {
      setCompany(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setCompany(null);
    try {
      const data = await api<{ company: Company }>(
        `/companies/${companyId}`,
        getOfficeRequestOptions(options.officeId)
      );
      if (requestId !== requestRef.current) return;
      setCompany(data.company);
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load company");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, [companyId, options.officeId]);

  useEffect(() => {
    fetchCompany();
  }, [fetchCompany]);

  return { company, loading, error, refetch: fetchCompany };
}

export interface CompanyContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  category: string;
  ownerUserId?: string | null;
  ownerUserName?: string | null;
}

export function useCompanyContacts(companyId: string | undefined, options: OfficeRequestOptions = {}) {
  const [contacts, setContacts] = useState<CompanyContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const fetchContacts = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!companyId) {
      setContacts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setContacts([]);
    try {
      const data = await api<{ contacts: CompanyContact[] }>(
        `/companies/${companyId}/contacts`,
        getOfficeRequestOptions(options.officeId)
      );
      if (requestId !== requestRef.current) return;
      setContacts(data.contacts);
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, [companyId, options.officeId]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  return { contacts, loading, error, refetch: fetchContacts };
}

export interface CompanyDeal {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  isActive: boolean;
  companyId: string | null;
  propertyId: string | null;
  sourceLeadId: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  stageEnteredAt: string;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useCompanyDeals(companyId: string | undefined) {
  const [deals, setDeals] = useState<CompanyDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDeals = useCallback(async () => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ deals: CompanyDeal[] }>(`/companies/${companyId}/deals`);
      setDeals(data.deals);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deals");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, loading, error };
}

// --- Mutation Functions ---

export interface CompanyDedupSuggestion {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  dealCount: number;
  matchReason: string;
}

export async function createCompany(input: {
  name: string;
  category?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  website?: string | null;
  notes?: string | null;
  skipDedupCheck?: boolean;
}, options: OfficeRequestOptions = {}) {
  // On a name-duplicate the server returns 200 { company: null, dedupWarning, suggestions }
  // instead of creating — the caller warns and re-submits with skipDedupCheck to override.
  return api<{ company: Company | null; dedupWarning?: boolean; suggestions?: CompanyDedupSuggestion[] }>("/companies", {
    method: "POST",
    json: input,
    ...getOfficeRequestOptions(options.officeId),
  });
}

export async function updateCompany(companyId: string, input: Partial<Company>) {
  return api<{ company: Company }>(`/companies/${companyId}`, { method: "PATCH", json: input });
}

export async function verifyCompany(companyId: string) {
  return api<{ company: Company }>(`/companies/${companyId}/verify`, { method: "POST" });
}

export async function searchCompanies(query: string, options: OfficeRequestOptions = {}) {
  return api<{ companies: Array<{ id: string; name: string; category: string | null; ownerUserId: string | null; ownerUserName: string | null }> }>(
    `/companies/search?q=${encodeURIComponent(query)}`,
    getOfficeRequestOptions(options.officeId)
  );
}
