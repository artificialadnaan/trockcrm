import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";

export interface FeedPhoto {
  id: string;
  displayName: string;
  mimeType: string;
  subcategory: string | null;
  dealId: string | null;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
  r2Key: string;
  takenAt: string | null;
  createdAt: string;
  geoLat: string | null;
  geoLng: string | null;
  uploadedBy: string;
  dealNumber: string | null;
  dealName: string | null;
  uploaderName: string | null;
}

/** Where a photo came from. Mirrors PHOTO_FEED_SOURCES in server/src/modules/files/feed-service.ts. */
export type FeedSource = "companycam" | "trock";

export interface FeedFilters {
  dealId?: string;
  uploadedBy?: string;
  subcategory?: string;
  /** Phase (files.photo_category). The literal "uncategorized" selects photos with no phase set. */
  photoCategory?: string;
  source?: FeedSource;
  dateFrom?: string;
  dateTo?: string;
  // Not a server filter — bump this to force a refetch (e.g. after assigning rescued photos to a deal so the
  // newly-linked photos appear in the feed instead of waiting on the 30s new-photo poll).
  refreshToken?: number;
}

export function usePhotoFeed(filters: FeedFilters = {}) {
  const [photos, setPhotos] = useState<FeedPhoto[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [newCount, setNewCount] = useState(0);
  // Distinct from `loading`: lets the page say the FILTERS failed rather than render an empty grid that
  // reads as "no photos match".
  const [error, setError] = useState(false);
  const lastFetchedAt = useRef<string>(new Date().toISOString());
  // Monotonic request id: a filter/refreshToken change (or page change) can leave an older request in
  // flight that resolves AFTER the newer one and would otherwise clobber the fresh feed. Only the latest
  // request applies state.
  const requestSeq = useRef(0);

  const fetchFeed = useCallback(
    async (pageNum: number = 1) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", String(pageNum));
        params.set("limit", "40");
        if (filters.dealId) params.set("dealId", filters.dealId);
        if (filters.uploadedBy) params.set("uploadedBy", filters.uploadedBy);
        if (filters.subcategory) params.set("subcategory", filters.subcategory);
        if (filters.photoCategory) params.set("photoCategory", filters.photoCategory);
        if (filters.source) params.set("source", filters.source);
        if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
        if (filters.dateTo) params.set("dateTo", filters.dateTo);

        const data = await api<{
          photos: FeedPhoto[];
          pagination: {
            page: number;
            limit: number;
            total: number;
            totalPages: number;
          };
        }>(`/files/photos/feed?${params}`);

        if (seq !== requestSeq.current) return; // a newer request superseded this one — ignore stale data
        setError(false);
        setPhotos(data.photos);
        setPage(data.pagination.page);
        setTotalPages(data.pagination.totalPages);
        setTotal(data.pagination.total);
        lastFetchedAt.current = new Date().toISOString();
        setNewCount(0);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        console.error("Failed to fetch photo feed:", err);
        setError(true);
        if (pageNum === 1) {
          // A page-1 request is a REPLACEMENT: a filter just changed. Leaving the previous query's
          // photos and totals on screen renders them beneath the newly selected controls as though they
          // matched — one query's rows labelled with another query's filters. Same rule the Projects tab
          // applies to its own replacement failures.
          setPhotos([]);
          setTotal(0);
          setTotalPages(0);
          setPage(1);
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      filters.dealId,
      filters.uploadedBy,
      filters.subcategory,
      filters.photoCategory,
      filters.source,
      filters.dateFrom,
      filters.dateTo,
      filters.refreshToken,
    ]
  );

  useEffect(() => {
    fetchFeed(1);
  }, [fetchFeed]);

  // Poll for new photos every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const data = await api<{ count: number }>(
          `/files/photos/feed/count?since=${encodeURIComponent(lastFetchedAt.current)}`
        );
        setNewCount(data.count);
      } catch {
        // Ignore polling errors
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const loadNewPhotos = () => fetchFeed(1);
  const goToPage = (p: number) => fetchFeed(p);

  return { photos, page, totalPages, total, loading, error, newCount, loadNewPhotos, goToPage };
}
