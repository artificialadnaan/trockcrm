import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  companyName: string | null;
  jobTitle: string | null;
  category: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  touchpointCount: number;
  lastContactedAt: string | null;
  firstOutreachCompleted: boolean;
  procoreContactId: number | null;
  hubspotContactId: string | null;
  normalizedPhone: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContactFilters {
  search?: string;
  category?: string;
  companyName?: string;
  companyId?: string;
  jobTitle?: string;
  city?: string;
  state?: string;
  regionId?: string;
  dealStageId?: string;
  isActive?: boolean;
  hasOutreach?: boolean;
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

export function useContacts(filters: ContactFilters = {}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.category) params.set("category", filters.category);
      if (filters.companyName) params.set("companyName", filters.companyName);
      if (filters.companyId) params.set("companyId", filters.companyId);
      if (filters.jobTitle) params.set("jobTitle", filters.jobTitle);
      if (filters.city) params.set("city", filters.city);
      if (filters.state) params.set("state", filters.state);
      if (filters.regionId) params.set("regionId", filters.regionId);
      if (filters.dealStageId) params.set("dealStageId", filters.dealStageId);
      if (filters.isActive === false) params.set("isActive", "false");
      if (filters.hasOutreach === true) params.set("hasOutreach", "true");
      if (filters.hasOutreach === false) params.set("hasOutreach", "false");
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortDir) params.set("sortDir", filters.sortDir);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ contacts: Contact[]; pagination: Pagination }>(
        `/contacts${qs ? `?${qs}` : ""}`
      );
      setContacts(data.contacts);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, [
    filters.search,
    filters.category,
    filters.companyName,
    filters.companyId,
    filters.jobTitle,
    filters.city,
    filters.state,
    filters.regionId,
    filters.dealStageId,
    filters.isActive,
    filters.hasOutreach,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  return { contacts, pagination, loading, error, refetch: fetchContacts };
}

export function useContactDetail(contactId: string | undefined) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContact = useCallback(async () => {
    if (!contactId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ contact: Contact }>(`/contacts/${contactId}`);
      setContact(data.contact);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contact");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    fetchContact();
  }, [fetchContact]);

  return { contact, loading, error, refetch: fetchContact };
}

export interface ContactDealAssociation {
  id: string;
  contactId: string;
  dealId: string;
  role: string | null;
  isPrimary: boolean;
  createdAt: string;
  deal: {
    id: string;
    dealNumber: string;
    name: string;
    stageId: string;
    isActive: boolean;
  };
}

export function useContactDeals(contactId: string | undefined) {
  const [associations, setAssociations] = useState<ContactDealAssociation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAssociations = useCallback(async () => {
    if (!contactId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ associations: ContactDealAssociation[] }>(
        `/contacts/${contactId}/deals`
      );
      setAssociations(data.associations);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deal associations");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    fetchAssociations();
  }, [fetchAssociations]);

  return { associations, loading, error, refetch: fetchAssociations };
}

// --- Mutation Functions ---

export async function createContact(input: Partial<Contact> & { firstName: string; lastName: string; category: string; skipDedupCheck?: boolean }) {
  return api<{ contact: Contact | null; dedupWarning?: boolean; suggestions?: Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; matchReason: string }> }>("/contacts", {
    method: "POST",
    json: input,
  });
}

export async function updateContact(contactId: string, input: Partial<Contact>) {
  return api<{ contact: Contact }>(`/contacts/${contactId}`, { method: "PATCH", json: input });
}

export async function deleteContact(contactId: string) {
  return api<{ success: boolean }>(`/contacts/${contactId}`, { method: "DELETE" });
}

export async function checkDuplicates(input: { firstName: string; lastName: string; email?: string; companyName?: string }) {
  return api<{ hardBlock: boolean; existingContact?: Contact; fuzzySuggestions: Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; matchReason: string }> }>("/contacts/dedup-check", {
    method: "POST",
    json: input,
  });
}

export async function searchContacts(query: string, limit = 10) {
  return api<{ contacts: Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; category: string }> }>(
    `/contacts/search?q=${encodeURIComponent(query)}&limit=${limit}`
  );
}

export async function addContactToDeal(contactId: string, dealId: string, role?: string, isPrimary?: boolean) {
  return api<{ association: ContactDealAssociation }>(`/contacts/${contactId}/deals`, {
    method: "POST",
    json: { dealId, role, isPrimary },
  });
}

export async function removeContactDealAssociation(associationId: string) {
  return api<{ success: boolean }>(`/contacts/associations/${associationId}`, { method: "DELETE" });
}
