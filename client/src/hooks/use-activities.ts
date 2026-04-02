import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Activity {
  id: string;
  type: string;
  userId: string;
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
  dealId?: string;
  contactId?: string;
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
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.contactId) params.set("contactId", filters.contactId);
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
  }, [filters.dealId, filters.contactId, filters.type, filters.page, filters.limit]);

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
    dealId?: string;
  }
) {
  return api<{ activity: Activity }>(`/contacts/${contactId}/activities`, {
    method: "POST",
    json: { ...input, contactId },
  });
}
