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

/**
 * Edit an already-uploaded photo's display name / description (field-auth PATCH /field/photos/:id).
 * Invalidates the project's photo cache — qk.projectPhotos takes BOTH (uid, dealId) — so the gallery /
 * viewer refetch the new name/description after a save.
 */
export function useUpdatePhotoMetadata(dealId?: string) {
  const { fetcher, user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { photoId: string; displayName?: string; description?: string | null }) =>
      api.updatePhotoMetadata(fetcher, vars.photoId, {
        displayName: vars.displayName,
        description: vars.description,
      }),
    onSuccess: () => {
      if (user && dealId) {
        void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, dealId) });
      }
    },
  });
}

// Server caps a photo page at 200; on a 400+ photo deal one request can't return everything, so we page
// through and concatenate. Bounded concurrency keeps it fast without flooding the rate limiter.
const PHOTOS_PER_PAGE = 200;
const PHOTOS_PAGE_CONCURRENCY = 3;
// Hard ceiling on pages fetched, so a bad totalPages can never spin forever (200 * 50 = 10k photos).
const PHOTOS_MAX_PAGES = 50;

/**
 * A server-side date window for the gallery. Both bounds are inclusive `YYYY-MM-DD` day strings, matched
 * by the server against COALESCE(taken_at, created_at).
 *
 * This is the ONLY way to reach a photo past PHOTOS_MAX_PAGES. The walk is newest-first, so on a project
 * over the ceiling the pages that fall off are the OLDEST — and the gallery's other filters (category,
 * tag, uploader) run client-side over whatever was loaded, so they cannot bring a dropped photo back.
 * Narrowing the window server-side changes which photos exist to be paged at all.
 */
export type ProjectPhotoWindow = {
  from?: string;
  to?: string;
  /**
   * The zone the day bounds were computed in. Supplied BY THE CALLER rather than resolved here, so the
   * query, its cache key, and anything else built from the same window (the viewer's URL re-scan) are
   * guaranteed to agree.
   *
   * Resolving it inside this hook looked equivalent and was not: it re-read the device zone on every
   * render, so after an automatic zone change any unrelated state update would reload the month in the
   * NEW zone while the screen still handed the viewer the OLD one — two halves of the same screen
   * disagreeing about which days "September" means. One value, passed down, cannot drift from itself.
   */
  timeZone?: string;
};

/**
 * The device's IANA zone, or undefined when the runtime cannot name one — in which case the server keeps
 * its historical session-zone behaviour rather than being handed a guess.
 */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function hasWindow(window?: ProjectPhotoWindow): boolean {
  return Boolean(window?.from || window?.to);
}

/** ALL photos for a project in the given window (paged through server-side, concatenated). */
export function useProjectPhotos(dealId: string | undefined, window?: ProjectPhotoWindow) {
  const { fetcher, user } = useAuth();
  const queryClient = useQueryClient();
  const from = window?.from || undefined;
  const to = window?.to || undefined;
  // The zone the day bounds were computed in, sent so the server buckets by the SAME calendar the user
  // picked from. `from`/`to` are bare days, and a day is not an instant: the database session is UTC, so
  // unqualified "2026-09-01" means 2026-09-01T00:00Z, which in Dallas is Aug 31 at 19:00. Without this,
  // a September window ran Aug 31 19:00 -> Sep 30 19:00 local — carrying the end of August and dropping
  // the last evening of September, which on a jobsite is real work in both directions.
  //
  // Falls back to the device zone only when a caller supplies none; the gallery always supplies one.
  const timeZone = window?.timeZone || deviceTimeZone();
  // The window AND the zone are both part of the identity of this result. Without the dates, changing
  // the month would serve the previous window from cache and the filter would look like it did nothing.
  // Without the zone, a device that crosses a time-zone boundary with a warm cache keeps serving photos
  // bucketed by the OLD zone — same month key, different answer — so the boundary photos this whole
  // change exists to get right would be wrong again until something forced a refetch.
  const queryKey = [
    ...qk.projectPhotos(user?.id ?? "anon", dealId ?? ""),
    from ?? "",
    to ?? "",
    timeZone ?? "",
  ];
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const page1 = { page: 1, perPage: PHOTOS_PER_PAGE, from, to, timeZone };
      const first = await api.getProjectPhotos(fetcher, dealId!, page1);
      const reportedPages = first.pagination?.totalPages ?? 1;
      const totalPages = Math.min(reportedPages, PHOTOS_MAX_PAGES);

      // TWO different incompletenesses, deliberately reported separately — they need different words and
      // different remedies, and conflating them produced a banner that told users to retry something
      // retrying cannot fix:
      //   `partial`   — a page request FAILED (429/5xx). Transient; refreshing genuinely may fix it.
      //   `truncated` — the project has more photos than the page ceiling can carry. Structural;
      //                 refreshing is futile forever, and the only remedy is a narrower date window.
      let partial = false;
      const truncated = reportedPages > PHOTOS_MAX_PAGES;

      // Deduped as we go rather than at the end, because every intermediate publish below is rendered.
      // Independently-fetched pages can overlap, and a duplicate id breaks every consumer that keys on
      // one — the viewer's FlatList keyExtractor most visibly, where it renders a blank page.
      const seen = new Set<string>();
      const photos: typeof first.photos = [];
      const absorb = (page: typeof first.photos) => {
        for (const photo of page) {
          if (seen.has(photo.id)) continue;
          seen.add(photo.id);
          photos.push(photo);
        }
      };

      const snapshot = (complete: boolean) => ({
        photos: [...photos],
        pagination: first.pagination,
        partial,
        truncated,
        windowed: hasWindow(window),
        oldestAt: first.pagination?.oldestAt ?? null,
        /**
         * False while later pages are still arriving. Report and share gate on it: building from a set
         * that is still filling would silently omit whatever had not landed yet, which is the same
         * hazard `partial` exists for.
         */
        complete,
      });

      /**
       * Publish what we have SO FAR, so the gallery paints instead of waiting on the whole walk.
       *
       * This is the "took forever to load" half of the original report. The server side is fixed — a
       * page is ~1.3ms of database time now instead of ~36ms — but the client still waited for EVERY
       * page before rendering anything, and District at Boynton is 8,652 photos, i.e. 44 pages. At three
       * concurrent requests that is ~15 sequential round trips of jobsite cellular before a single
       * thumbnail appeared. Page 1 is the newest 200 photos, which is what someone opening the gallery
       * is almost always looking for, so it goes on screen immediately and the rest fills in behind it.
       *
       * Writing to the cache from inside the queryFn is deliberate: the alternative (useInfiniteQuery)
       * fetches strictly one page at a time, which would make the FULL load markedly slower in exchange
       * for the same first paint — a bad trade when report/share need the complete set.
       */
      const publish = (complete: boolean) => {
        const next = snapshot(complete);
        // NEVER write from a walk that has been cancelled. Pull-to-refresh while pages are still
        // arriving starts a replacement walk and cancels this one — but cancellation does not stop an
        // async function, it only makes React Query ignore its RETURN. Writing straight to the cache
        // side-steps that: the abandoned walk keeps publishing, and if one of its older batches resolves
        // last it overwrites the fresh result with stale photos and `complete: false`. The gallery would
        // then show the previous load's set with report and share disabled, and nothing would correct it
        // until the user refreshed again — a refresh that makes things worse is about the least
        // forgivable behaviour available here.
        if (signal.aborted) return next;
        queryClient.setQueryData(queryKey, next);
        return next;
      };

      absorb(first.photos);
      publish(false);

      for (let page = 2; page <= totalPages; page += PHOTOS_PAGE_CONCURRENCY) {
        // Stop FETCHING once cancelled, not merely stop publishing. Suppressing the writes alone left an
        // abandoned walk downloading every remaining page — on a 50-page gallery that is thousands of
        // photos still being fetched and server-presigned, competing for bandwidth and pool with the
        // replacement query the user is actually waiting on. Checked before scheduling each batch and
        // again after it settles, because the cancellation usually lands mid-batch.
        if (signal.aborted) break;
        const batch = [];
        for (let p = page; p < page + PHOTOS_PAGE_CONCURRENCY && p <= totalPages; p += 1) {
          batch.push(
            api.getProjectPhotos(fetcher, dealId!, { page: p, perPage: PHOTOS_PER_PAGE, from, to, timeZone }),
          );
        }
        // allSettled, not all: a transient 429/5xx on one later page must not blank the whole gallery —
        // we keep every page that did load (page 1 is already in `photos`).
        const results = await Promise.allSettled(batch);
        if (signal.aborted) break;
        for (const result of results) {
          if (result.status === "fulfilled") absorb(result.value.photos);
          else partial = true;
        }
        publish(false);
      }

      // Enforce the guarantee the comment above only claimed. `partial` previously caught a rejected page
      // and the page cap, but not the case where the walk simply came back with fewer photos than the
      // server counted — which OFFSET paging over a live table produces for free: delete a photo while
      // pages 2..18 are in flight and every later page shifts by one, so a row is never returned by any
      // page. No fetch fails, so nothing was flagged, and the shortfall renders as a slightly smaller
      // photo count that looks entirely plausible — while Report and Share stay enabled over a set that is
      // quietly missing photos. Comparing against the page-1 count closes that. Only a SHORTFALL counts:
      // photos added mid-walk can legitimately push the length past the original total.
      //
      // Guarded on `!truncated`: over the ceiling the walk is SUPPOSED to return fewer photos than the
      // server counted, so this shortfall check would otherwise fire every time and re-conflate the two
      // states it was just separated from.
      const reportedTotal = first.pagination?.total;
      if (!truncated && typeof reportedTotal === "number" && photos.length < reportedTotal) partial = true;

      return snapshot(true);
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

/**
 * A below-band scorecard's corrective-action items + their inline responses (Plan 2's read endpoint).
 * Mirrors useScorecard: keyed on (user, scorecardId), calls getCorrectiveActions. The endpoint 404s when the
 * scorecard has no corrective actions (not below-band / unknown), which the screen surfaces as empty. A short
 * staleTime + the screen's focus-refetch keep the item statuses fresh after a response is submitted elsewhere.
 */
export function useCorrectiveActions(scorecardId: string | undefined) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: qk.correctiveActions(user?.id ?? "anon", scorecardId ?? ""),
    queryFn: () => api.getCorrectiveActions(fetcher, scorecardId!),
    enabled: !!user && !!scorecardId,
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

/**
 * Capture-target search (deals/leads/opps) for the target picker. `dealsOnly` restricts to deals
 * (scorecard); `includeTerminalDeals` additionally drops the browsing stage rule, so Lost/terminal
 * deals are offered too (walkthrough recovery only — see RecoveryProjectPicker).
 *
 * Both flags are part of the cache key: they are different QUESTIONS, not a view of one answer, and
 * the recovery picker asks two of them at once for the same search term.
 */
export function useCaptureTargets(search: string, dealsOnly = false, includeTerminalDeals = false) {
  const { fetcher, user } = useAuth();
  return useQuery({
    queryKey: [...qk.targets(user?.id ?? "anon", search), dealsOnly, includeTerminalDeals] as const,
    queryFn: () => api.searchCaptureTargets(fetcher, search.trim(), 20, dealsOnly, includeTerminalDeals),
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
