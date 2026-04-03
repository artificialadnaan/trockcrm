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
}

export interface FeedFilters {
  dealId?: string;
  uploadedBy?: string;
  subcategory?: string;
  dateFrom?: string;
  dateTo?: string;
}

export function usePhotoFeed(filters: FeedFilters = {}) {
  const [photos, setPhotos] = useState<FeedPhoto[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastFetchedAt = useRef<string>(new Date().toISOString());

  const fetchFeed = useCallback(
    async (pageNum: number = 1) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", String(pageNum));
        params.set("limit", "40");
        if (filters.dealId) params.set("dealId", filters.dealId);
        if (filters.uploadedBy) params.set("uploadedBy", filters.uploadedBy);
        if (filters.subcategory) params.set("subcategory", filters.subcategory);
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

        setPhotos(data.photos);
        setPage(data.pagination.page);
        setTotalPages(data.pagination.totalPages);
        setTotal(data.pagination.total);
        lastFetchedAt.current = new Date().toISOString();
        setNewCount(0);
      } catch (err) {
        console.error("Failed to fetch photo feed:", err);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      filters.dealId,
      filters.uploadedBy,
      filters.subcategory,
      filters.dateFrom,
      filters.dateTo,
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

  return { photos, page, totalPages, total, loading, newCount, loadNewPhotos, goToPage };
}
