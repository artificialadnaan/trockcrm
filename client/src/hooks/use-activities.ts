import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export type ActivitySourceEntityType = "company" | "property" | "lead" | "deal" | "contact";

export interface Activity {
  id: string;
  type: string;
  responsibleUserId: string;
  performedByUserId: string | null;
  sourceEntityType: ActivitySourceEntityType;
  sourceEntityId: string;
  companyId: string | null;
  propertyId: string | null;
  leadId: string | null;
  dealId: string | null;
  contactId: string | null;
  emailId: string | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  durationMinutes: number | null;
  occurredAt: string;
  createdAt: string;
}

export interface ActivityFilters {
  companyId?: string;
  propertyId?: string;
  leadId?: string;
  dealId?: string;
  contactId?: string;
  responsibleUserId?: string;
  sourceEntityType?: ActivitySourceEntityType;
  sourceEntityId?: string;
  type?: string;
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useActivities(filters: ActivityFilters = {}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.companyId) params.set("companyId", filters.companyId);
      if (filters.propertyId) params.set("propertyId", filters.propertyId);
      if (filters.leadId) params.set("leadId", filters.leadId);
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.contactId) params.set("contactId", filters.contactId);
      if (filters.responsibleUserId) params.set("responsibleUserId", filters.responsibleUserId);
      if (filters.sourceEntityType) params.set("sourceEntityType", filters.sourceEntityType);
      if (filters.sourceEntityId) params.set("sourceEntityId", filters.sourceEntityId);
      if (filters.type) params.set("type", filters.type);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ activities: Activity[]; pagination: Pagination }>(
        `/activities${qs ? `?${qs}` : ""}`
      );
      setActivities(data.activities);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load activities");
    } finally {
      setLoading(false);
    }
  }, [
    filters.companyId,
    filters.propertyId,
    filters.leadId,
    filters.dealId,
    filters.contactId,
    filters.responsibleUserId,
    filters.sourceEntityType,
    filters.sourceEntityId,
    filters.type,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  return { activities, pagination, loading, error, refetch: fetchActivities };
}

export async function createActivity(input: {
  type: string;
  subject?: string;
  body?: string;
  outcome?: string;
  durationMinutes?: number;
  responsibleUserId?: string;
  sourceEntityType?: ActivitySourceEntityType;
  sourceEntityId?: string;
  companyId?: string;
  propertyId?: string;
  leadId?: string;
  dealId?: string;
  contactId?: string;
  occurredAt?: string;
}) {
  return api<{ activity: Activity }>("/activities", { method: "POST", json: input });
}

export async function createContactActivity(
  contactId: string,
  input: {
    type: string;
    subject?: string;
    body?: string;
    outcome?: string;
    durationMinutes?: number;
    responsibleUserId?: string;
    dealId?: string;
  }
) {
  return api<{ activity: Activity }>(`/contacts/${contactId}/activities`, {
    method: "POST",
    json: { ...input, contactId },
  });
}
