import type { CurrentUser, ProgressResponse, QueueResponse, ReassignmentRecordsResponse, ReassignmentUser, RecordDetail, RecordTypeSingular, SkipReason } from "../types/cleanup";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  me: () => request<CurrentUser>("/api/auth/me"),
  queue: () => request<QueueResponse>("/api/cleanup/queue"),
  progress: () => request<ProgressResponse>("/api/cleanup/progress"),
  record: (type: RecordTypeSingular, id: string) => request<RecordDetail>(`/api/cleanup/record/${type}/${id}`),
  patchRecord: (type: RecordTypeSingular, id: string, body: Record<string, unknown>) =>
    request<RecordDetail>(`/api/cleanup/record/${type}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  skipRecord: (type: RecordTypeSingular, id: string, body: { skip_reason: SkipReason; skip_notes?: string }) =>
    request<{ status: string; id: string; type: RecordTypeSingular }>(`/api/cleanup/record/${type}/${id}/skip`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  flagDuplicate: (type: RecordTypeSingular, id: string) =>
    request<{ status: string; id: string; type: RecordTypeSingular }>(`/api/cleanup/record/${type}/${id}/flag-duplicate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  historicalPass: () =>
    request<{ updated: number; byUser: Array<{ userId: string; count: number }> }>("/api/cleanup/bulk/historical-pass", {
      method: "POST",
      body: JSON.stringify({ record_type: "deal" }),
    }),
  completeOnboarding: () => request<{ success: boolean; reason?: string; progress?: ProgressResponse }>("/api/cleanup/complete-onboarding", { method: "POST", body: JSON.stringify({}) }),
  search: (entity: "contacts" | "companies" | "properties", q: string) =>
    request<Array<{ id: string; display_name: string; subtitle?: string | null; meta?: string | null }>>(`/api/cleanup/search/${entity}?q=${encodeURIComponent(q)}`),
  createProperty: (body: { company_id: string; name?: string; address?: string; city?: string; state?: string; zip?: string }) =>
    request<{ id: string; display_name: string; subtitle?: string | null; meta?: string | null }>("/api/cleanup/properties", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  reassignmentUsers: () => request<ReassignmentUser[]>("/api/cleanup/admin/reassignment-users"),
  reassignmentRecords: (params: { type: string; q: string; owner: string; page: number }) =>
    request<ReassignmentRecordsResponse>(
      `/api/cleanup/admin/reassignment-records?type=${encodeURIComponent(params.type)}&q=${encodeURIComponent(params.q)}&owner=${encodeURIComponent(params.owner)}&page=${params.page}`,
    ),
  reassignRecord: (type: RecordTypeSingular, id: string, body: { newAssignedToUserId: string; reason?: string }) =>
    request(`/api/cleanup/admin/records/${type}/${id}/reassign`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  bulkReassignRecords: (body: { type: string; recordIds: string[]; newAssignedToUserId: string; reason?: string }) =>
    request("/api/cleanup/admin/records/bulk-reassign", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
