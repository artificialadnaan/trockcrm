import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { RecordTypeSingular, SkipReason } from "../types/cleanup";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
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
