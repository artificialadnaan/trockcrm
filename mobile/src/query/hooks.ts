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

// Server caps a photo page at 200; on a 400+ photo deal one request can't return everything, so we page
// through and concatenate. Bounded concurrency keeps it fast without flooding the rate limiter.
const PHOTOS_PER_PAGE = 200;
const PHOTOS_PAGE_CONCURRENCY = 3;
// Hard ceiling on pages fetched, so a bad totalPages can never spin forever (200 * 50 = 10k photos).
const PHOTOS_MAX_PAGES = 50;

/** ALL photos for a project (paged through server-side, concatenated); filtering/grouping is client-side. */
export function useProjectPhotos(dealId: string | undefined) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.projectPhotos(user?.id ?? "anon", dealId ?? ""),
    queryFn: async () => {
      const first = await api.getProjectPhotos(fetcher, dealId!, { page: 1, perPage: PHOTOS_PER_PAGE });
      const reportedPages = first.pagination?.totalPages ?? 1;
      const totalPages = Math.min(reportedPages, PHOTOS_MAX_PAGES);
      const photos = [...first.photos];

      // `partial` tracks pages we couldn't load. We keep the non-blanking behavior (show what loaded) but
      // surface partial so the screen can block report/share — generating from an incomplete set would
      // silently omit photos. Hitting the page cap (>10k photos) is also a truncation → partial.
      let partial = reportedPages > PHOTOS_MAX_PAGES;
      for (let page = 2; page <= totalPages; page += PHOTOS_PAGE_CONCURRENCY) {
        const batch = [];
        for (let p = page; p < page + PHOTOS_PAGE_CONCURRENCY && p <= totalPages; p += 1) {
          batch.push(api.getProjectPhotos(fetcher, dealId!, { page: p, perPage: PHOTOS_PER_PAGE }));
        }
        // allSettled, not all: a transient 429/5xx on one later page must not blank the whole gallery —
        // we keep every page that did load (page 1 is already in `photos`).
        const results = await Promise.allSettled(batch);
        for (const result of results) {
          if (result.status === "fulfilled") photos.push(...result.value.photos);
          else partial = true;
        }
      }

      return { photos, pagination: first.pagination, partial };
    },
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

/** Submitted scorecards for one project (the project-detail Scorecards section). Mirrors useProjectReports. */
export function useProjectScorecards(dealId: string | undefined) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.projectScorecards(user?.id ?? "anon", dealId ?? ""),
    queryFn: () => api.getProjectScorecards(fetcher, dealId!),
    enabled: !!user && !!dealId,
  });
}

/**
 * One submitted scorecard's full detail (items, deficiencies, action items, photos w/ presigned URLs).
 * The endpoint resolves the owning office by scorecard id, so id-only nav works cross-office. A short
 * staleTime + the screen's focus-refetch keep the ~60-min presigned photo/PDF URLs fresh.
 */
export function useScorecard(id: string | undefined) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.scorecard(user?.id ?? "anon", id ?? ""),
    queryFn: () => api.getScorecard(fetcher, id!),
    enabled: !!user && !!id,
    staleTime: 30_000,
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

/** Capture-target search (deals/leads/opps) for the target picker. `dealsOnly` restricts to deals (scorecard). */
export function useCaptureTargets(search: string, dealsOnly = false) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: [...qk.targets(user?.id ?? "anon", search), dealsOnly] as const,
    queryFn: () => api.searchCaptureTargets(fetcher, search.trim(), 20, dealsOnly),
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
