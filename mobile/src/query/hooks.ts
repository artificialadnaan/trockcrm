import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import * as api from "../api/endpoints";
import { qk } from "./keys";

/**
 * Paginated active-projects list (50/page server-side), filtered by search. When `coords` is supplied the
 * server orders the list by proximity (closest first) and stamps each row's distance; the coords are in
 * the query key so a new GPS fix refetches in the new order.
 */
export function useProjects(search: string, coords?: { lat: number; lng: number } | null) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.projects(user?.id ?? "anon", search, coords ?? null),
    queryFn: () =>
      api.getProjects(fetcher, {
        search: search.trim() || undefined,
        perPage: 50,
        lat: coords?.lat,
        lng: coords?.lng,
      }),
    enabled: !!user,
  });
}

/**
 * Starred projects (skipped while searching, like the web app). Passes the GPS fix so starred rows carry
 * the same distanceMiles the list shows (and the pinned set reads nearest-first); coords are in the key.
 */
export function useStarredProjects(enabled: boolean, coords?: { lat: number; lng: number } | null) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.starred(user?.id ?? "anon", coords ?? null),
    queryFn: () => api.getStarredProjects(fetcher, coords),
    enabled: enabled && !!user,
  });
}

export function useToggleStar() {
  const { fetcher, user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dealId, starred }: { dealId: string; starred: boolean }) =>
      starred ? api.unstarProject(fetcher, dealId) : api.starProject(fetcher, dealId),
    onSuccess: () => {
      if (!user) return;
      // prefix-invalidate every ["projects", uid, *] and ["starred", uid, *] bucket (all search/coords
      // variants), so a star toggle refreshes the cached `starred` flag everywhere it's shown.
      void qc.invalidateQueries({ queryKey: ["projects", user.id] });
      void qc.invalidateQueries({ queryKey: ["starred", user.id] });
    },
  });
}

/** All photos for a project; filtering/grouping happens client-side. */
export function useProjectPhotos(dealId: string | undefined) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.projectPhotos(user?.id ?? "anon", dealId ?? ""),
    queryFn: () => api.getProjectPhotos(fetcher, dealId!),
    enabled: !!user && !!dealId,
  });
}

export function useProjectReports(dealId: string | undefined) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.projectReports(user?.id ?? "anon", dealId ?? ""),
    queryFn: () => api.getProjectReports(fetcher, dealId!),
    enabled: !!user && !!dealId,
  });
}

export function usePendingPhotos() {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.pending(user?.id ?? "anon"),
    queryFn: () => api.getPendingPhotos(fetcher),
    enabled: !!user,
  });
}

/** Tag autocomplete for a project (only fires once the user has typed). */
export function useProjectTags(dealId: string | undefined, q: string) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.projectTags(user?.id ?? "anon", dealId ?? "", q),
    queryFn: () => api.getProjectTags(fetcher, dealId!, q),
    enabled: !!user && !!dealId && q.trim().length > 0,
  });
}

/** Capture-target search (deals/leads/opps) for the target picker. */
export function useCaptureTargets(search: string) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.targets(user?.id ?? "anon", search),
    queryFn: () => api.searchCaptureTargets(fetcher, search.trim()),
    enabled: !!user && search.trim().length > 0,
  });
}

export function useNearbyCaptureTargets(
  coords: { latitude: number; longitude: number } | null,
  enabled = true,
  limit = 3,
) {
  const { fetcher, user } = useAuth();
  const hasCoords = Number.isFinite(coords?.latitude) && Number.isFinite(coords?.longitude);
  return useQuery({
    queryKey: qk.nearbyTargets(user?.id ?? "anon", coords?.latitude ?? null, coords?.longitude ?? null, limit),
    queryFn: () =>
      api.getNearbyCaptureTargets(fetcher, {
        latitude: coords!.latitude,
        longitude: coords!.longitude,
        limit,
      }),
    enabled: enabled && !!user && hasCoords,
    staleTime: 60_000,
  });
}
