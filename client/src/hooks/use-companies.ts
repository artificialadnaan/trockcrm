import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

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
  notes: string | null;
  contactCount: number;
  dealCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyFilters {
  search?: string;
  category?: string;
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

  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.category) params.set("category", filters.category);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ companies: Company[]; total: number; page: number; limit: number }>(
        `/companies${qs ? `?${qs}` : ""}`
      );
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
      setError(err instanceof Error ? err.message : "Failed to load companies");
    } finally {
      setLoading(false);
    }
  }, [filters.search, filters.category, filters.page, filters.limit]);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  return { companies, pagination, loading, error, refetch: fetchCompanies };
}

export function useCompanyDetail(companyId: string | undefined) {
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCompany = useCallback(async () => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ company: Company }>(`/companies/${companyId}`);
      setCompany(data.company);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load company");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

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
}

export function useCompanyContacts(companyId: string | undefined) {
  const [contacts, setContacts] = useState<CompanyContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContacts = useCallback(async () => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ contacts: CompanyContact[] }>(`/companies/${companyId}/contacts`);
      setContacts(data.contacts);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

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
}) {
  return api<{ company: Company }>("/companies", { method: "POST", json: input });
}

export async function updateCompany(companyId: string, input: Partial<Company>) {
  return api<{ company: Company }>(`/companies/${companyId}`, { method: "PATCH", json: input });
}

export async function searchCompanies(query: string) {
  return api<{ companies: Array<{ id: string; name: string; category: string | null }> }>(
    `/companies/search?q=${encodeURIComponent(query)}`
  );
}
