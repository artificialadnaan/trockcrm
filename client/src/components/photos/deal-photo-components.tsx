import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Filter,
  MapPin,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { getImmediatePhotoOpenUrl, getImmediatePhotoPreviewUrl, isPhotoImagePreviewable, shouldFetchSignedPhotoUrl } from "@/lib/photo-url-resolution";
import { ZoomableImage } from "@/components/photos/zoomable-image";
import {
  LEGACY_PHOTO_CATEGORY_ITEMS,
  PHOTO_CATEGORY_OPTION_ITEMS,
  photoCategoryLabel,
  type PhotoCategory,
} from "@trock-crm/shared/types";
import { PhotoHistoryTimeline } from "./photo-history-timeline";

export type PhotoGrouping = "date" | "category" | "uploader" | "none";
export type { PhotoCategory };

export interface DealPhotoRecord {
  id: string;
  category: "photo";
  photoCategory: PhotoCategory | null;
  subcategory: string | null;
  displayName: string;
  mimeType: string;
  fileSizeBytes?: number;
  fileExtension?: string;
  r2Key: string;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
  // Server-resolved display URLs (batched into the list) — used directly so the client never fetches a
  // signed URL per photo. thumbnailUrl = grid; fullUrl = high-res for the zoomable viewer. Optional because
  // other endpoints (PATCH, etc.) return the raw file record without them.
  thumbnailUrl?: string | null;
  fullUrl?: string | null;
  description: string | null;
  takenAt: string | null;
  createdAt: string;
  uploadedBy: string;
  uploaderName: string;
  uploaderAvatarUrl: string | null;
  latitude: string | null;
  longitude: string | null;
  address: string | null;
  addressSource: "exif" | "live_gps" | "deal_fallback" | "manual_override" | null;
  geocodedAt: string | null;
  procoreSyncStatus: "pending" | "synced" | "failed" | "skipped" | null;
  deletedAt: string | null;
  deletedByUserId: string | null;
  tags: string[];
}

export interface PhotoFilterState {
  categories: string[];
  tags: string[];
  uploaderIds: string[];
  from: string;
  to: string;
  group: PhotoGrouping;
  showDeleted: boolean;
}

// The 6 phase categories offered when tagging a photo (shared single source of
// truth). Legacy values are surfaced in the filter only, never offered for new
// tagging — see PhotoFilterBar / displayPhotoCategory.
export const PHOTO_CATEGORIES = PHOTO_CATEGORY_OPTION_ITEMS;

const GROUP_OPTIONS: Array<{ value: PhotoGrouping; label: string }> = [
  { value: "date", label: "Date" },
  { value: "category", label: "Category" },
  { value: "uploader", label: "Uploader" },
  { value: "none", label: "None" },
];

export const DEAL_PHOTO_PAGE_SIZE = 100;

export const defaultPhotoFilters: PhotoFilterState = {
  categories: [],
  tags: [],
  uploaderIds: [],
  from: "",
  to: "",
  group: "date",
  showDeleted: false,
};

export function useInViewport<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [inViewport, setInViewport] = useState(false);

  useEffect(() => {
    if (!node || inViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [inViewport, node]);

  return [setNode, inViewport];
}

function ordinal(day: number) {
  if (day > 3 && day < 21) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

export function formatDateHeading(value: string) {
  const date = new Date(value);
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const month = date.toLocaleDateString("en-US", { month: "long" });
  return `${weekday}, ${month} ${ordinal(date.getDate())}, ${date.getFullYear()}`;
}

export function formatPhotoTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function initials(name?: string | null) {
  return name?.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export function displayPhotoCategory(photo: DealPhotoRecord): string | null {
  // photoCategoryLabel resolves both the 6 offered values and retained legacy
  // values, so photos tagged before the phase rollout still show their label.
  if (photo.photoCategory) return photoCategoryLabel(photo.photoCategory);
  // Web capture stores the phase on `subcategory`; route it through the shared
  // label map so it reads "Final Completion", not "final completion".
  if (photo.subcategory) return photoCategoryLabel(photo.subcategory);
  return null;
}

export function photoSortTime(photo: DealPhotoRecord) {
  return new Date(photo.takenAt ?? photo.createdAt).getTime();
}

export function getPhotoTags(tags: string[] | null | undefined) {
  return Array.isArray(tags) ? tags : [];
}

export function buildPhotoFilterSearchParams(filters: PhotoFilterState, options: { includeGroup?: boolean } = {}): URLSearchParams {
  const includeGroup = options.includeGroup ?? true;
  const params = new URLSearchParams();
  if (filters.categories.length > 0) params.set("category", filters.categories.join(","));
  if (filters.tags.length > 0) params.set("tags", filters.tags.join(","));
  if (filters.uploaderIds.length > 0) params.set("uploader", filters.uploaderIds.join(","));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (includeGroup && filters.group !== "date") params.set("group", filters.group);
  if (filters.showDeleted) params.set("deleted", "1");
  return params;
}

export function filtersFromSearchParams(params: URLSearchParams): PhotoFilterState {
  const group = params.get("group");
  return {
    categories: params.get("category")?.split(",").filter(Boolean) ?? [],
    tags: params.get("tags")?.split(",").filter(Boolean) ?? [],
    uploaderIds: params.get("uploader")?.split(",").filter(Boolean) ?? [],
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    group: group === "category" || group === "uploader" || group === "none" ? group : "date",
    showDeleted: params.get("deleted") === "1" || params.get("deleted") === "true",
  };
}

/**
 * The category token a photo is filtered/grouped by: its photoCategory, else its
 * subcategory normalised to the same snake_case shape as the filter values
 * (so a web-captured "Site Visit" subcategory matches the "site_visit" chip),
 * else "uncategorized".
 */
export function photoFilterCategory(photo: DealPhotoRecord): string {
  return photo.photoCategory ?? (photo.subcategory ? photo.subcategory.toLowerCase().replace(/\s+/g, "_") : "uncategorized");
}

export function matchesPhotoFilters(photo: DealPhotoRecord, filters: PhotoFilterState) {
  if (!filters.showDeleted && photo.deletedAt) return false;
  if (filters.categories.length > 0) {
    if (!filters.categories.includes(photoFilterCategory(photo))) return false;
  }
  if (filters.tags.length > 0) {
    const selectedTags = filters.tags.map((tag) => tag.toLowerCase());
    const photoTags = getPhotoTags(photo.tags).map((tag) => tag.toLowerCase());
    if (!photoTags.some((tag) => selectedTags.includes(tag))) return false;
  }
  if (filters.uploaderIds.length > 0 && !filters.uploaderIds.includes(photo.uploadedBy)) return false;
  const day = new Date(photo.takenAt ?? photo.createdAt).toISOString().slice(0, 10);
  if (filters.from && day < filters.from) return false;
  if (filters.to && day > filters.to) return false;
  return true;
}

/**
 * Legacy (retired) category options to surface in the filter, so historical
 * photos stay filterable without offering retired values for new captures.
 *
 * When the photo set is fully loaded we show only the legacy categories actually
 * in use (no empty chips). While more pages remain (`allLoaded=false`) we can't
 * yet know which legacy categories exist — and legacy photos are the oldest, so
 * they sit on the LAST pages — so we surface all of them rather than hide the
 * only UI path to filter them.
 */
export function legacyCategoryOptionsInUse(
  photos: DealPhotoRecord[],
  allLoaded = true
): Array<{ value: string; label: string }> {
  if (!allLoaded) return [...LEGACY_PHOTO_CATEGORY_ITEMS];
  const present = new Set(photos.map(photoFilterCategory));
  return LEGACY_PHOTO_CATEGORY_ITEMS.filter((option) => present.has(option.value));
}

export function groupDealPhotos(photos: DealPhotoRecord[], filters: PhotoFilterState) {
  const visible = photos.filter((photo) => matchesPhotoFilters(photo, filters)).sort((a, b) => photoSortTime(b) - photoSortTime(a));
  const groups = new Map<string, { label: string; photos: DealPhotoRecord[]; sort: number | string }>();

  for (const photo of visible) {
    let key = "all";
    let label = "All photos";
    let sort: number | string = 0;
    if (filters.group === "date") {
      key = new Date(photo.takenAt ?? photo.createdAt).toISOString().slice(0, 10);
      label = formatDateHeading(photo.takenAt ?? photo.createdAt);
      sort = photoSortTime(photo);
    } else if (filters.group === "category") {
      label = displayPhotoCategory(photo) ?? "Uncategorized";
      key = label;
      sort = label;
    } else if (filters.group === "uploader") {
      key = photo.uploadedBy;
      label = photo.uploaderName || "Unknown";
      sort = label;
    }
    const existing = groups.get(key) ?? { label, photos: [], sort };
    existing.photos.push(photo);
    if (typeof sort === "number" && typeof existing.sort === "number") existing.sort = Math.max(existing.sort, sort);
    groups.set(key, existing);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (typeof a.sort === "number" && typeof b.sort === "number") return b.sort - a.sort;
    return String(a.sort).localeCompare(String(b.sort));
  });
}

export function useDealPhotosData({
  dealId,
  filters,
  onCountChange,
}: {
  dealId: string;
  filters: PhotoFilterState;
  onCountChange?: (count: number) => void;
}) {
  const [photos, setPhotos] = useState<DealPhotoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: DEAL_PHOTO_PAGE_SIZE,
    total: 0,
    totalPages: 0,
  });
  // Deal-wide uploader facet from the server, so the filter dropdown lists every contributor regardless
  // of which numbered page is shown (deriving it from the current page would drop uploaders off-page).
  const [uploaderFacets, setUploaderFacets] = useState<Array<{ id: string; name: string; avatarUrl: string | null }>>([]);
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const previewRequests = React.useRef(new Map<string, Promise<string>>());
  const requestId = React.useRef(0);
  // The page the user last asked for — so the error-state Retry re-fetches THAT page, not page 1.
  const requestedPage = React.useRef(1);
  // The page range currently displayed. Numbered pages replace → a single page [p, p]; the load-more
  // subview accumulates → [1, lastLoaded]. A mutation refresh reloads exactly this range, clamped.
  const loadedRange = React.useRef({ first: 1, last: 1 });

  // Photos we've already force-refreshed once after an <img> error. Bounds the recovery to a SINGLE retry
  // per photo so a permanently-broken object (404, deleted R2 key) can't loop onError → refetch → onError
  // and hammer /files/:id/download until the rate limiter trips.
  const refreshedIds = React.useRef(new Set<string>());

  // When the list endpoint returns fresh photos it carries newly-signed batched URLs (6h). Drop any one-off
  // recovery URL (1h, from a prior onError) for those ids so the fresher list URL wins — otherwise the stale
  // recovery URL keeps being preferred and, once it expires, refreshedIds blocks another refresh (broken tile
  // until remount). Clearing refreshedIds too re-arms recovery against the new URL.
  const pruneRecoveryCache = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    for (const id of ids) refreshedIds.current.delete(id);
    setDownloadUrls((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of ids) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const fetchPhotosPage = useCallback(async (page: number, options: { append?: boolean } = {}) => {
    const append = options.append ?? false;
    requestedPage.current = page;
    const currentRequestId = requestId.current + 1;
    requestId.current = currentRequestId;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setPhotos([]);
    }
    setError(null);
    setLoadMoreError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(DEAL_PHOTO_PAGE_SIZE) });
      const filterParams = buildPhotoFilterSearchParams(filters);
      filterParams.forEach((value, key) => params.set(key, value));
      const data = await api<{ photos: DealPhotoRecord[]; pagination: { page: number; limit: number; total: number; totalPages: number }; facets?: { uploaders: Array<{ id: string; name: string; avatarUrl: string | null }> } }>(`/files/deal/${dealId}/photos?${params}`);
      if (requestId.current !== currentRequestId) return;
      setPagination(data.pagination);
      if (data.facets?.uploaders) setUploaderFacets(data.facets.uploaders);
      loadedRange.current = append
        ? { first: Math.min(loadedRange.current.first, page), last: Math.max(loadedRange.current.last, page) }
        : { first: page, last: page };
      setPhotos((current) => {
        if (!append) return data.photos;
        const merged = new Map(current.map((photo) => [photo.id, photo]));
        data.photos.forEach((photo) => merged.set(photo.id, photo));
        return Array.from(merged.values());
      });
      // These rows just arrived with fresh batched URLs — retire any stale recovery URL for them.
      pruneRecoveryCache(data.photos.map((photo) => photo.id));
      onCountChange?.(data.pagination.total);
    } catch (err) {
      if (requestId.current === currentRequestId) {
        const message = err instanceof Error ? err.message : "Failed to load photos";
        if (append) {
          setLoadMoreError(message);
        } else {
          setError(message);
        }
      }
    } finally {
      if (requestId.current === currentRequestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [dealId, filters, onCountChange, pruneRecoveryCache]);

  const fetchPhotos = useCallback(async () => {
    await fetchPhotosPage(1);
  }, [fetchPhotosPage]);

  const loadMorePhotos = useCallback(async () => {
    if (loading || loadingMore || pagination.page >= pagination.totalPages) return;
    await fetchPhotosPage(pagination.page + 1, { append: true });
  }, [fetchPhotosPage, loading, loadingMore, pagination.page, pagination.totalPages]);

  // Numbered pages: jump to a page, REPLACING the current set (not accumulating). Clamped to [1, totalPages].
  const goToPage = useCallback(async (page: number) => {
    const totalPages = Math.max(1, pagination.totalPages || 1);
    const target = Math.min(Math.max(1, page), totalPages);
    if (loading) return;
    // Re-clicking the current page is a no-op ONLY when it's already showing photos. After a failed jump
    // (photos cleared, error set, pagination.page still the old page) the current-page click must reload.
    if (target === pagination.page && !error && photos.length > 0) return;
    await fetchPhotosPage(target);
  }, [error, fetchPhotosPage, loading, pagination.page, pagination.totalPages, photos.length]);

  // Reload exactly the currently-displayed page range after a mutation (delete/restore): one page for the
  // numbered tab, the accumulated [1..n] span for the load-more subview. If a delete shrank the set so the
  // range overshoots totalPages (e.g. removing the only photo on page 2), clamp/back up to the last valid
  // page instead of replacing with an empty over-shot page.
  const refreshLoadedPhotos = useCallback(async () => {
    const currentRequestId = requestId.current + 1;
    requestId.current = currentRequestId;
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    const filterParams = buildPhotoFilterSearchParams(filters);
    const fetchPage = (p: number) => {
      const params = new URLSearchParams({ page: String(p), limit: String(DEAL_PHOTO_PAGE_SIZE) });
      filterParams.forEach((value, key) => params.set(key, value));
      return api<{ photos: DealPhotoRecord[]; pagination: { page: number; limit: number; total: number; totalPages: number }; facets?: { uploaders: Array<{ id: string; name: string; avatarUrl: string | null }> } }>(
        `/files/deal/${dealId}/photos?${params}`,
      );
    };
    // Reload [lo..hi] in bounded chunks rather than one big Promise.all — the Files subview can have many
    // pages loaded, and a delete/restore would otherwise burst dozens of simultaneous requests and trip the
    // very rate limiter this PR exists to relieve.
    const REFRESH_CHUNK = 4;
    const fetchRange = async (lo: number, hi: number) => {
      const results: Array<Awaited<ReturnType<typeof fetchPage>>> = [];
      for (let start = lo; start <= hi; start += REFRESH_CHUNK) {
        const end = Math.min(start + REFRESH_CHUNK - 1, hi);
        const chunk = await Promise.all(Array.from({ length: end - start + 1 }, (_, i) => fetchPage(start + i)));
        results.push(...chunk);
      }
      return results;
    };
    try {
      let { first, last } = loadedRange.current;
      let pages = await fetchRange(first, last);
      if (requestId.current !== currentRequestId) return;
      const totalPages = Math.max(1, pages[0]?.pagination.totalPages ?? 1);
      if (last > totalPages) {
        last = totalPages;
        first = Math.min(first, totalPages); // numbered (first===last) jumps to the last valid page
        pages = await fetchRange(first, last);
        if (requestId.current !== currentRequestId) return;
      }
      loadedRange.current = { first, last };
      const merged = new Map<string, DealPhotoRecord>();
      pages.forEach((pageResult) => pageResult.photos.forEach((photo) => merged.set(photo.id, photo)));
      const latest = pages[pages.length - 1]!.pagination;
      const mergedPhotos = Array.from(merged.values());
      setPhotos(mergedPhotos);
      setPagination(latest);
      // The endpoint returns the deal-wide uploader facet — refresh it so a mutation that removes an
      // uploader's last photo drops them from the filter dropdown (instead of leaving a stale option).
      const refreshedFacets = pages.find((pageResult) => pageResult.facets?.uploaders)?.facets?.uploaders;
      if (refreshedFacets) setUploaderFacets(refreshedFacets);
      // Freshly reloaded rows carry new batched URLs — retire stale recovery URLs for them.
      pruneRecoveryCache(mergedPhotos.map((photo) => photo.id));
      requestedPage.current = latest.page;
      onCountChange?.(latest.total);
    } catch (err) {
      if (requestId.current === currentRequestId) setError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      if (requestId.current === currentRequestId) setLoading(false);
    }
  }, [dealId, filters, onCountChange, pruneRecoveryCache]);

  // Retry the page the user last requested (the failed target), not page 1.
  const retry = useCallback(async () => {
    await fetchPhotosPage(requestedPage.current);
  }, [fetchPhotosPage]);

  useEffect(() => {
    void fetchPhotos();
  }, [fetchPhotos]);

  // Photos we've already force-refreshed once after an <img> error. Bounds the recovery to a SINGLE retry
  // per photo so a permanently-broken object (404, deleted R2 key) can't loop onError → refetch → onError
  // and hammer /files/:id/download until the rate limiter trips.
  const getPhotoImageUrl = useCallback((photo: DealPhotoRecord) => {
    return getImmediatePhotoPreviewUrl(photo, downloadUrls[photo.id]) ?? "";
  }, [downloadUrls]);

  // High-res "open" URL for the lightbox, signed-URL aware — so after a tile recovers an expired R2 URL,
  // opening the viewer uses the fresh one instead of the stale batched fullUrl.
  //
  // Sharing the `downloadUrls` cache with the preview path is intentional and does NOT downscale the
  // viewer: `?preview=1` on /files/:id/download is only an audit-logging flag (it never resizes — the route
  // returns the same presigned R2 ORIGINAL). And `downloadUrls` is populated ONLY for R2-backed photos
  // (shouldFetchSignedPhotoUrl is false for external CompanyCam photos that carry their own thumb/full URLs),
  // where resolvePhotoDisplayUrls sets thumbnailUrl === fullUrl. So there is no preview-vs-full distinction
  // to lose here; a separate "open URL" cache would be dead complexity.
  const getPhotoOpenUrl = useCallback((photo: DealPhotoRecord) => {
    return getImmediatePhotoOpenUrl(photo, downloadUrls[photo.id]) ?? "";
  }, [downloadUrls]);

  const ensurePhotoImageUrl = useCallback(async (photo: DealPhotoRecord) => {
    const currentUrl = downloadUrls[photo.id];
    const immediateUrl = getImmediatePhotoPreviewUrl(photo, currentUrl);
    if (!shouldFetchSignedPhotoUrl(photo, currentUrl)) return immediateUrl ?? "";

    const pendingRequest = previewRequests.current.get(photo.id);
    if (pendingRequest) return pendingRequest;

    const request = api<{ url: string }>(`/files/${photo.id}/download?preview=1`)
      .then((data) => {
        setDownloadUrls((current) => ({ ...current, [photo.id]: data.url }));
        return data.url;
      })
      .finally(() => {
        previewRequests.current.delete(photo.id);
      });

    previewRequests.current.set(photo.id, request);
    return request;
  }, [downloadUrls]);

  // Force a FRESH signed URL — used when an <img> errors (e.g. a batched R2 URL expired after a long-open
  // gallery). Always fetches (bypasses the batched-URL short-circuit), deduped per photo. The new URL is
  // stored in downloadUrls, and getImmediatePhoto*Url prefers a present signed URL over the stale batched one.
  const refreshPhotoSignedUrl = useCallback(async (photo: DealPhotoRecord) => {
    if (!isPhotoImagePreviewable(photo)) return "";
    // One recovery attempt per photo — a fresh signed URL that ALSO fails is a permanent error, so stop
    // rather than re-fetch on every subsequent onError.
    if (refreshedIds.current.has(photo.id)) return downloadUrls[photo.id] ?? "";
    refreshedIds.current.add(photo.id);
    const pending = previewRequests.current.get(photo.id);
    if (pending) return pending;
    const request = api<{ url: string }>(`/files/${photo.id}/download?preview=1`)
      .then((data) => {
        setDownloadUrls((current) => ({ ...current, [photo.id]: data.url }));
        return data.url;
      })
      .finally(() => {
        previewRequests.current.delete(photo.id);
      });
    previewRequests.current.set(photo.id, request);
    return request;
  }, [downloadUrls]);

  async function patchPhoto(photoId: string, body: Record<string, unknown>) {
    const { file } = await api<{ file: DealPhotoRecord }>(`/files/${photoId}`, { method: "PATCH", json: body });
    setPhotos((current) => current.map((photo) => (photo.id === photoId ? { ...photo, ...file } : photo)));
  }

  async function savePhotoAddress(photoId: string, body: { address: string; latitude?: number; longitude?: number }) {
    const { file } = await api<{ file: DealPhotoRecord }>(`/files/${photoId}/address`, { method: "PATCH", json: body });
    setPhotos((current) => current.map((photo) => (photo.id === photoId ? { ...photo, ...file } : photo)));
  }

  async function deletePhoto(photoId: string) {
    await api(`/files/${photoId}`, { method: "DELETE" });
    await refreshLoadedPhotos();
  }

  async function restorePhoto(photoId: string) {
    await patchPhoto(photoId, { deletedAt: null, deletedByUserId: null });
    await refreshLoadedPhotos();
  }

  async function downloadPhoto(photoId: string) {
    const data = await api<{ url: string }>(`/files/${photoId}/download`);
    window.open(data.url, "_blank");
  }

  return {
    photos,
    loading,
    loadingMore,
    error,
    loadMoreError,
    pagination,
    uploaderFacets,
    hasMorePhotos: pagination.page < pagination.totalPages,
    fetchPhotos,
    loadMorePhotos,
    goToPage,
    retry,
    getPhotoImageUrl,
    getPhotoOpenUrl,
    ensurePhotoImageUrl,
    refreshPhotoSignedUrl,
    patchPhoto,
    savePhotoAddress,
    deletePhoto,
    restorePhoto,
    downloadPhoto,
  };
}

export function PhotoPaginationSummary({
  loadedCount,
  totalCount,
  hasMore,
  loadingMore,
  loadMoreError,
  showLoadMore = true,
  onLoadMore,
}: {
  loadedCount: number;
  totalCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError?: string | null;
  showLoadMore?: boolean;
  onLoadMore: () => void;
}) {
  if (totalCount === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
      <div className="space-y-1">
        <span>
          Showing {loadedCount.toLocaleString()} of {totalCount.toLocaleString()} photos
        </span>
        {loadMoreError && <p className="text-xs text-red-600">Could not load more photos. Try again.</p>}
      </div>
      {showLoadMore && hasMore && (
        <Button type="button" variant="outline" size="sm" aria-label="Load more photos" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}

/** Compact page list: 1 … p-1 p p+1 … N (no gaps for small counts). */
function buildPageItems(page: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const items = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  const sorted = Array.from(items).filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) result.push("ellipsis");
    result.push(n);
  });
  return result;
}

/** Numbered-page navigation for the photo grid (replaces "Load more"). Each page replaces the grid. */
export function PhotoPageNavigator({
  page,
  totalPages,
  total,
  loading,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  if (total === 0 || totalPages <= 1) return null;
  const items = buildPageItems(page, totalPages);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
      <span>Page {page.toLocaleString()} of {totalPages.toLocaleString()} · {total.toLocaleString()} photos</span>
      <div className="flex items-center gap-1">
        <Button type="button" variant="outline" size="sm" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)}>
          Prev
        </Button>
        {items.map((item, i) =>
          item === "ellipsis" ? (
            <span key={`e-${i}`} className="px-1 text-muted-foreground">…</span>
          ) : (
            <Button
              key={item}
              type="button"
              variant={item === page ? "default" : "outline"}
              size="sm"
              aria-label={`Page ${item}`}
              aria-current={item === page ? "page" : undefined}
              disabled={loading}
              onClick={() => onPageChange(item)}
            >
              {item}
            </Button>
          ),
        )}
        <Button type="button" variant="outline" size="sm" aria-label="Next page" disabled={loading || page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function PhotoFilterBar({
  filters,
  availableTags,
  uploaders,
  onChange,
  showGrouping = true,
  legacyCategoryOptions = LEGACY_PHOTO_CATEGORY_ITEMS,
}: {
  filters: PhotoFilterState;
  availableTags: string[];
  uploaders: Array<{ id: string; name: string; avatarUrl: string | null }>;
  onChange: (filters: PhotoFilterState) => void;
  showGrouping?: boolean;
  /**
   * Legacy (no-longer-offered) categories to surface in the filter so photos
   * tagged before the phase rollout stay reachable. Callers should pass only the
   * legacy values actually present in the current photo set; defaults to all
   * legacy values so old photos are never unreachable.
   */
  legacyCategoryOptions?: ReadonlyArray<{ value: string; label: string }>;
}) {
  const activeFilters = filters.categories.length + filters.tags.length + filters.uploaderIds.length + (filters.from ? 1 : 0) + (filters.to ? 1 : 0) + (filters.showDeleted ? 1 : 0);
  const categoryOptions = [
    ...PHOTO_CATEGORIES,
    { value: "uncategorized", label: "Uncategorized" },
    ...legacyCategoryOptions.map((option) => ({ value: option.value, label: `${option.label} (legacy)` })),
  ];
  return (
    <div data-testid="photo-filter-bar" className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
      <MultiSelectButton
        label="Category"
        selectedCount={filters.categories.length}
        options={categoryOptions}
        selected={filters.categories}
        onChange={(categories) => onChange({ ...filters, categories })}
      />
      {availableTags.length > 0 ? (
        <MultiSelectButton
          label="Tags"
          selectedCount={filters.tags.length}
          options={availableTags.map((tag) => ({ value: tag, label: `#${tag}` }))}
          selected={filters.tags}
          onChange={(tags) => onChange({ ...filters, tags })}
        />
      ) : null}
      <MultiSelectButton
        label="Uploader"
        selectedCount={filters.uploaderIds.length}
        options={uploaders.map((uploader) => ({ value: uploader.id, label: uploader.name, avatarUrl: uploader.avatarUrl }))}
        selected={filters.uploaderIds}
        onChange={(uploaderIds) => onChange({ ...filters, uploaderIds })}
      />
      <div className="flex items-center gap-1">
        <DateField value={filters.from} onChange={(from) => onChange({ ...filters, from })} className="h-8 w-[9rem]" />
        <span className="text-xs text-muted-foreground">to</span>
        <DateField value={filters.to} onChange={(to) => onChange({ ...filters, to })} className="h-8 w-[9rem]" />
      </div>
      {showGrouping && (
        <div className="flex rounded-md border bg-background p-0.5">
          {GROUP_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={`Group by ${option.label}`}
              className={`rounded px-2.5 py-1 text-xs font-medium ${filters.group === option.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => onChange({ ...filters, group: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      <Button
        type="button"
        variant={filters.showDeleted ? "default" : "outline"}
        size="sm"
        aria-label="Show deleted photos"
        onClick={() => onChange({ ...filters, showDeleted: !filters.showDeleted })}
      >
        Deleted
      </Button>
      {activeFilters > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onChange(defaultPhotoFilters)}>
          <X className="mr-1 h-4 w-4" />
          Clear filters
        </Button>
      )}
    </div>
  );
}

function MultiSelectButton({
  label,
  selectedCount,
  options,
  selected,
  onChange,
}: {
  label: string;
  selectedCount: number;
  options: Array<{ value: string; label: string; avatarUrl?: string | null }>;
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" aria-label={`${label} filter`}><Filter className="mr-1.5 h-4 w-4" />{label}{selectedCount > 0 ? ` (${selectedCount})` : ""}</Button>} />
      <PopoverContent align="start" className="space-y-1">
        {options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => onChange(checked ? selected.filter((value) => value !== option.value) : [...selected, option.value])}
            >
              <Checkbox checked={checked} onCheckedChange={() => undefined} />
              {option.avatarUrl !== undefined && <Avatar className="h-5 w-5"><AvatarImage src={option.avatarUrl ?? undefined} /><AvatarFallback>{initials(option.label)}</AvatarFallback></Avatar>}
              <span>{option.label}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function SourceBadge({ source }: { source: DealPhotoRecord["addressSource"] }) {
  const label = source === "exif"
    ? "From photo"
    : source === "live_gps"
      ? "Captured at upload"
      : source === "deal_fallback"
        ? "Project address"
        : source === "manual_override"
          ? "Manually set"
          : "No source";
  return <Badge variant="outline">{label}</Badge>;
}

export function PhotoViewerModal({
  photos,
  selectedId,
  onSelectedIdChange,
  getPhotoImageUrl,
  getPhotoOpenUrl,
  ensurePhotoImageUrl,
  refreshPhotoSignedUrl,
  patchPhoto,
  savePhotoAddress,
  deletePhoto,
  downloadPhoto,
}: {
  photos: DealPhotoRecord[];
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  getPhotoImageUrl: (photo: DealPhotoRecord) => string;
  getPhotoOpenUrl?: (photo: DealPhotoRecord) => string;
  ensurePhotoImageUrl: (photo: DealPhotoRecord) => Promise<string>;
  refreshPhotoSignedUrl?: (photo: DealPhotoRecord) => Promise<string>;
  patchPhoto: (photoId: string, body: Record<string, unknown>) => Promise<void>;
  savePhotoAddress: (photoId: string, body: { address: string; latitude?: number; longitude?: number }) => Promise<void>;
  deletePhoto: (photoId: string) => Promise<void>;
  downloadPhoto: (photoId: string) => Promise<void>;
}) {
  const [deleteCandidate, setDeleteCandidate] = useState<DealPhotoRecord | null>(null);
  const [addressDraft, setAddressDraft] = useState({ address: "", latitude: "", longitude: "" });
  const [captionDraft, setCaptionDraft] = useState("");
  const selectedIndex = selectedId ? photos.findIndex((photo) => photo.id === selectedId) : -1;
  const selectedPhoto = selectedIndex >= 0 ? photos[selectedIndex] : null;
  const selectedPhotoTags = getPhotoTags(selectedPhoto?.tags);
  const selectedUploaderName = selectedPhoto?.uploaderName ?? "Unknown user";
  const selectedPhotoIsImage = selectedPhoto ? isPhotoImagePreviewable(selectedPhoto) : false;
  const selectedPhotoImageUrl = selectedPhoto && selectedPhotoIsImage ? getPhotoImageUrl(selectedPhoto) : "";
  // The viewer shows the HIGH-RES (full) image so it stays sharp when zoomed; the grid keeps the thumbnail.
  // Falls back to the thumbnail until the full URL resolves.
  const selectedPhotoFullUrl =
    selectedPhoto && selectedPhotoIsImage
      ? (getPhotoOpenUrl ? getPhotoOpenUrl(selectedPhoto) : getImmediatePhotoOpenUrl(selectedPhoto) ?? "") || selectedPhotoImageUrl
      : "";

  useEffect(() => {
    if (!selectedPhoto || !isPhotoImagePreviewable(selectedPhoto) || getPhotoImageUrl(selectedPhoto)) return;
    void ensurePhotoImageUrl(selectedPhoto);
  }, [ensurePhotoImageUrl, getPhotoImageUrl, selectedPhoto]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!selectedPhoto) return;
      if (event.key === "ArrowLeft" && selectedIndex > 0) onSelectedIdChange(photos[selectedIndex - 1].id);
      if (event.key === "ArrowRight" && selectedIndex < photos.length - 1) onSelectedIdChange(photos[selectedIndex + 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelectedIdChange, photos, selectedIndex, selectedPhoto]);

  async function saveAddress(photo: DealPhotoRecord) {
    await savePhotoAddress(photo.id, {
      address: addressDraft.address,
      latitude: addressDraft.latitude ? Number(addressDraft.latitude) : undefined,
      longitude: addressDraft.longitude ? Number(addressDraft.longitude) : undefined,
    });
  }

  async function confirmDelete(photo: DealPhotoRecord) {
    await deletePhoto(photo.id);
    setDeleteCandidate(null);
    onSelectedIdChange(null);
  }

  return (
    <>
      <Dialog open={Boolean(selectedPhoto)} onOpenChange={(open) => !open && onSelectedIdChange(null)}>
        {selectedPhoto && (
          <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="flex min-h-[45vh] items-center justify-center overflow-hidden rounded-lg bg-black">
                {selectedPhotoFullUrl ? (
                  <ZoomableImage key={selectedPhoto.id} src={selectedPhotoFullUrl} alt={selectedPhoto.displayName} onError={() => void refreshPhotoSignedUrl?.(selectedPhoto)} />
                ) : selectedPhotoIsImage ? (
                  <div className="flex flex-col items-center gap-3 px-6 text-center text-white">
                    <Camera className="h-12 w-12 text-white/75" />
                    <p className="text-sm font-medium">Loading preview</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 px-6 text-center text-white">
                    <FileText className="h-12 w-12 text-white/75" />
                    <div>
                      <p className="text-sm font-medium">No image preview available</p>
                      <p className="mt-1 text-xs text-white/70">{selectedPhoto.mimeType || selectedPhoto.fileExtension || "File attachment"}</p>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-4">
                <DialogHeader>
                  <DialogTitle>{selectedPhoto.description || selectedPhoto.displayName}</DialogTitle>
                  <DialogDescription>{formatPhotoTime(selectedPhoto.takenAt ?? selectedPhoto.createdAt)} · {selectedUploaderName}</DialogDescription>
                </DialogHeader>

                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Caption</span>
                    <Popover>
                      <PopoverTrigger render={<Button variant="ghost" size="sm" onClick={() => setCaptionDraft(selectedPhoto.description ?? "")}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>} />
                      <PopoverContent align="end" className="space-y-2">
                        <Input value={captionDraft} onChange={(event) => setCaptionDraft(event.target.value)} placeholder="Caption" />
                        <Button size="sm" onClick={() => patchPhoto(selectedPhoto.id, { description: captionDraft.trim() || null })}>Save caption</Button>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <p className="text-sm text-muted-foreground">{selectedPhoto.description || "No caption"}</p>
                </section>

                <section className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags</span>
                  {selectedPhotoTags.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedPhotoTags.map((tag) => <Badge key={tag} variant="outline">#{tag}</Badge>)}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No tags</p>
                  )}
                </section>

                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</span>
                    <Popover>
                      <PopoverTrigger render={<Button variant="ghost" size="sm"><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>} />
                      <PopoverContent align="end">
                        <div className="grid gap-1">
                          {[...PHOTO_CATEGORIES, { value: null, label: "Clear category" }].map((category) => (
                            <button key={category.label} type="button" className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => patchPhoto(selectedPhoto.id, { photoCategory: category.value })}>
                              {category.label}
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <Badge variant={selectedPhoto.photoCategory ? "secondary" : "outline"}>{displayPhotoCategory(selectedPhoto) ?? "Uncategorized"}</Badge>
                </section>

                <section className="space-y-2 text-sm">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Uploaded by</span>
                  <div className="flex items-center gap-2">
                    <Avatar className="h-8 w-8"><AvatarImage src={selectedPhoto.uploaderAvatarUrl ?? undefined} /><AvatarFallback>{initials(selectedUploaderName)}</AvatarFallback></Avatar>
                    <div>
                      <p className="font-medium">{selectedUploaderName}</p>
                      <p className="text-xs text-muted-foreground">{new Date(selectedPhoto.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                  <p><span className="text-muted-foreground">Taken:</span> {selectedPhoto.takenAt ? new Date(selectedPhoto.takenAt).toLocaleString() : "Same as uploaded"}</p>
                </section>

                <section className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Location</span>
                    <Popover>
                      <PopoverTrigger
                        render={<Button variant="ghost" size="sm" onClick={() => setAddressDraft({
                          address: selectedPhoto.address ?? "",
                          latitude: selectedPhoto.latitude ?? "",
                          longitude: selectedPhoto.longitude ?? "",
                        })}><Pencil className="mr-1 h-3.5 w-3.5" />Edit address</Button>}
                      />
                      <PopoverContent align="end" className="space-y-2">
                        <Input value={addressDraft.address} onChange={(event) => setAddressDraft((draft) => ({ ...draft, address: event.target.value }))} placeholder="Street address" />
                        <div className="grid grid-cols-2 gap-2">
                          <Input value={addressDraft.latitude} onChange={(event) => setAddressDraft((draft) => ({ ...draft, latitude: event.target.value }))} placeholder="Latitude" />
                          <Input value={addressDraft.longitude} onChange={(event) => setAddressDraft((draft) => ({ ...draft, longitude: event.target.value }))} placeholder="Longitude" />
                        </div>
                        <Button size="sm" onClick={() => saveAddress(selectedPhoto)}>Save address</Button>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <p>{selectedPhoto.address ?? "No address saved"}</p>
                  {selectedPhoto.latitude && selectedPhoto.longitude && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => navigator.clipboard?.writeText(`${Number(selectedPhoto.latitude).toFixed(6)}, ${Number(selectedPhoto.longitude).toFixed(6)}`)}
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      {Number(selectedPhoto.latitude).toFixed(6)}, {Number(selectedPhoto.longitude).toFixed(6)}
                    </button>
                  )}
                  <SourceBadge source={selectedPhoto.addressSource} />
                </section>

                {selectedPhoto.procoreSyncStatus && (
                  <section className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procore</span>
                    <Badge variant="outline">{selectedPhoto.procoreSyncStatus}</Badge>
                  </section>
                )}

                <PhotoHistoryTimeline photoId={selectedPhoto.id} />

                <DialogFooter>
                  <Button variant="outline" onClick={() => downloadPhoto(selectedPhoto.id)}>
                    <Download className="mr-1.5 h-4 w-4" />
                    Download
                  </Button>
                  <Button variant="destructive" onClick={() => setDeleteCandidate(selectedPhoto)}>
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Delete
                  </Button>
                  <div className="ml-auto flex gap-1">
                    <Button variant="ghost" size="icon" disabled={selectedIndex <= 0} onClick={() => onSelectedIdChange(photos[selectedIndex - 1]?.id)}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" disabled={selectedIndex >= photos.length - 1} onClick={() => onSelectedIdChange(photos[selectedIndex + 1]?.id)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </DialogFooter>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={Boolean(deleteCandidate)} onOpenChange={(open) => !open && setDeleteCandidate(null)}>
        {deleteCandidate && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this photo?</DialogTitle>
              <DialogDescription>It can be restored from the trash for 90 days.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteCandidate(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => confirmDelete(deleteCandidate)}>Delete photo</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

export function PhotoGridTile({
  photo,
  imageUrl,
  loadImageUrl,
  onImageError,
  onOpen,
  onRestore,
}: {
  photo: DealPhotoRecord;
  imageUrl: string;
  loadImageUrl: () => void;
  /** Fired when the <img> fails (e.g. a batched signed URL expired) so the parent can fetch a fresh one. */
  onImageError?: () => void;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const [tileRef, inViewport] = useInViewport<HTMLDivElement>();
  const category = displayPhotoCategory(photo);
  const photoTags = getPhotoTags(photo.tags);
  const isImage = isPhotoImagePreviewable(photo);

  useEffect(() => {
    if (isImage && inViewport && !imageUrl) loadImageUrl();
  }, [imageUrl, inViewport, isImage, loadImageUrl]);

  return (
    <div ref={tileRef} className={`space-y-1 ${photo.deletedAt ? "opacity-55" : ""}`}>
      <button
        type="button"
        aria-label={`Open photo ${photo.displayName}`}
        className="group relative aspect-square w-full overflow-hidden rounded-lg border bg-muted text-left transition hover:ring-2 hover:ring-brand-red"
        onClick={onOpen}
      >
        {imageUrl ? (
          <img src={imageUrl} alt={photo.displayName} loading="lazy" className="h-full w-full object-cover" onError={() => onImageError?.()} />
        ) : (
          <div className="flex h-full items-center justify-center">
            {isImage ? <Camera className="h-7 w-7 text-muted-foreground" /> : <FileText className="h-7 w-7 text-muted-foreground" />}
          </div>
        )}
        <Avatar className="absolute bottom-2 left-2 h-7 w-7 border border-white shadow">
          <AvatarImage src={photo.uploaderAvatarUrl ?? undefined} />
          <AvatarFallback>{initials(photo.uploaderName)}</AvatarFallback>
        </Avatar>
        {category && <Badge className="absolute bottom-2 right-2 max-w-[70%] truncate text-[10px]">{category}</Badge>}
        {photo.deletedAt && <Badge variant="destructive" className="absolute left-2 top-2 text-[10px]">Deleted</Badge>}
      </button>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs text-muted-foreground">{formatPhotoTime(photo.takenAt ?? photo.createdAt)} • {photo.uploaderName}</p>
        {photo.deletedAt && (
          <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={onRestore}>
            <RotateCcw className="mr-1 h-3 w-3" />
            Restore
          </Button>
        )}
      </div>
      {photoTags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {photoTags.slice(0, 3).map((tag) => <Badge key={tag} variant="outline" className="max-w-[7rem] truncate text-[10px]">#{tag}</Badge>)}
          {photoTags.length > 3 ? <Badge variant="outline" className="text-[10px]">+{photoTags.length - 3}</Badge> : null}
        </div>
      ) : null}
    </div>
  );
}

export function PhotoEmptyState({ dealId, message }: { dealId: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-14 text-center">
      <Camera className="mb-3 h-10 w-10 text-muted-foreground" />
      <p className="text-sm font-medium">{message}</p>
      <Button nativeButton={false} render={<Link to={`/photos/capture?dealId=${encodeURIComponent(dealId)}`} />} className="mt-4">
        <Upload className="mr-1.5 h-4 w-4" />
        Upload photos
      </Button>
    </div>
  );
}

export function PhotoGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: 10 }).map((_, index) => <div key={index} className="aspect-square animate-pulse rounded-lg bg-muted" />)}
    </div>
  );
}

export function PhotoGroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
      <CalendarDays className="h-4 w-4" />
      {label}
      <span className="text-xs font-normal">({count})</span>
    </h4>
  );
}
