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

export function useToggleStar() {
  const { fetcher, user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dealId, starred }: { dealId: string; starred: boolean }) =>
      starred ? api.unstarProject(fetcher, dealId) : api.starProject(fetcher, dealId),
    onSuccess: () => {
      if (!user) return;
      // prefix-invalidate every ["projects", uid, *] and the starred list
      void qc.invalidateQueries({ queryKey: ["projects", user.id] });
      void qc.invalidateQueries({ queryKey: qk.starred(user.id) });
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
      const totalPages = Math.min(first.pagination?.totalPages ?? 1, PHOTOS_MAX_PAGES);
      const photos = [...first.photos];

      // `partial` tracks pages we couldn't load. We keep the non-blanking behavior (show what loaded) but
      // surface partial so the screen can block report/share — generating from an incomplete set would
      // silently omit photos.
      let partial = false;
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
