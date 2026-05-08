import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { RecordTypeSingular, SkipReason } from "../types/cleanup";

function mainCrmApiUrl(path: string) {
  const base = import.meta.env.VITE_MAIN_CRM_BASE_URL ?? "https://trockcrm.com";
  return `${base.replace(/\/$/, "")}/api${path}`;
}

async function logoutEverywhere() {
  await Promise.allSettled([
    api.logout(),
    fetch(mainCrmApiUrl("/auth/logout"), {
      method: "POST",
      credentials: "include",
    }),
  ]);
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutEverywhere,
    onSettled: () => {
      queryClient.clear();
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.localStorage.setItem("cleanup_logged_out", "true");
      window.location.assign("/login?loggedOut=1");
    },
  });
}

export function useQueue() {
  return useQuery({ queryKey: ["cleanup", "queue"], queryFn: api.queue });
}

export function useProgress() {
  return useQuery({ queryKey: ["cleanup", "progress"], queryFn: api.progress });
}

export function useReassignmentUsers(enabled: boolean) {
  return useQuery({ queryKey: ["cleanup", "admin", "reassignment-users"], queryFn: api.reassignmentUsers, enabled });
}

export function useAdminProgressSummary(enabled: boolean, refetchInterval?: number) {
  return useQuery({ queryKey: ["cleanup", "admin", "progress", "summary"], queryFn: api.adminProgressSummary, enabled, refetchInterval });
}

export function useAdminProgressByUser(enabled: boolean, refetchInterval?: number) {
  return useQuery({ queryKey: ["cleanup", "admin", "progress", "by-user"], queryFn: api.adminProgressByUser, enabled, refetchInterval });
}

export function useAdminProgressUser(userId: string | undefined, page: number, enabled: boolean, filters?: { status?: string; q?: string }) {
  return useQuery({
    queryKey: ["cleanup", "admin", "progress", "user", userId, page, filters?.status ?? "all", filters?.q ?? ""],
    queryFn: () => api.adminProgressUser(userId!, page, filters),
    enabled: enabled && Boolean(userId),
  });
}

export function useCleanupSummaryReport(enabled: boolean) {
  return useQuery({ queryKey: ["cleanup", "admin", "reports", "cleanup-summary"], queryFn: api.cleanupSummaryReport, enabled });
}

export function useReassignmentRecords(params: { type: string; q: string; owner: string; page: number }, enabled: boolean) {
  return useQuery({
    queryKey: ["cleanup", "admin", "reassignment-records", params],
    queryFn: () => api.reassignmentRecords(params),
    enabled,
  });
}

export function useReassignmentMutations() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["cleanup", "admin", "reassignment-records"] }),
      queryClient.invalidateQueries({ queryKey: ["cleanup", "queue"] }),
      queryClient.invalidateQueries({ queryKey: ["cleanup", "progress"] }),
    ]);
  };
  return {
    single: useMutation({
      mutationFn: ({ type, id, newAssignedToUserId }: { type: RecordTypeSingular; id: string; newAssignedToUserId: string }) =>
        api.reassignRecord(type, id, { newAssignedToUserId, reason: "admin reassignment" }),
      onSuccess: invalidate,
    }),
    bulk: useMutation({
      mutationFn: ({ type, recordIds, newAssignedToUserId }: { type: string; recordIds: string[]; newAssignedToUserId: string }) =>
        api.bulkReassignRecords({ type, recordIds, newAssignedToUserId, reason: "admin bulk reassignment" }),
      onSuccess: invalidate,
    }),
  };
}

export function useRecord(type: RecordTypeSingular, id: string) {
  return useQuery({ queryKey: ["cleanup", "record", type, id], queryFn: () => api.record(type, id), enabled: Boolean(type && id) });
}

export function useCleanupMutations(type?: RecordTypeSingular, id?: string) {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["cleanup", "queue"] }),
      queryClient.invalidateQueries({ queryKey: ["cleanup", "progress"] }),
      queryClient.invalidateQueries({ queryKey: ["cleanup", "record", type, id] }),
    ]);
  };
  return {
    patch: useMutation({
      mutationFn: (body: Record<string, unknown>) => api.patchRecord(type!, id!, body),
      onSuccess: invalidate,
    }),
    note: useMutation({
      mutationFn: (body: { note: string }) => api.createRecordNote(type!, id!, body),
      onSuccess: invalidate,
    }),
    skip: useMutation({
      mutationFn: (body: { skip_reason: SkipReason; skip_notes?: string }) => api.skipRecord(type!, id!, body),
      onSuccess: invalidate,
    }),
    flagDuplicate: useMutation({
      mutationFn: () => api.flagDuplicate(type!, id!),
      onSuccess: invalidate,
    }),
    historicalPass: useMutation({
      mutationFn: api.historicalPass,
      onSuccess: invalidate,
    }),
    completeOnboarding: useMutation({
      mutationFn: api.completeOnboarding,
      onSuccess: invalidate,
    }),
  };
}
