import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import * as api from "../api/endpoints";
import { qk } from "./keys";

/** Paginated active-projects list (50/page server-side), filtered by search. */
export function useProjects(search: string) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.projects(user?.id ?? "anon", search),
    queryFn: () => api.getProjects(fetcher, { search: search.trim() || undefined, perPage: 50 }),
    enabled: !!user,
  });
}

/** Starred projects (skipped while searching, like the web app). */
export function useStarredProjects(enabled: boolean) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.starred(user?.id ?? "anon"),
    queryFn: () => api.getStarredProjects(fetcher),
    enabled: enabled && !!user,
  });
}

/**
 * The 3 active projects closest to `coords`. Disabled (never fires) without a GPS fix or while the user
 * is searching, so the Nearby section simply doesn't render in those cases — no permission nagging.
 */
export function useNearbyProjects(coords: { lat: number; lng: number } | null, enabled: boolean) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.nearby(user?.id ?? "anon", coords?.lat ?? 0, coords?.lng ?? 0),
    queryFn: () => api.getNearbyProjects(fetcher, coords!.lat, coords!.lng),
    enabled: enabled && !!user && !!coords,
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
      // prefix-invalidate every ["projects", uid, *], the starred list, and every nearby coordinate
      // bucket — Nearby rows also show the star, so their cached `starred` must refresh after a toggle.
      void qc.invalidateQueries({ queryKey: ["projects", user.id] });
      void qc.invalidateQueries({ queryKey: qk.starred(user.id) });
      void qc.invalidateQueries({ queryKey: ["nearby", user.id] });
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
