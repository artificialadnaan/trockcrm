import { useState, useMemo, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Camera,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { usePhotoFeed, type FeedFilters, type FeedPhoto } from "@/hooks/use-photo-feed";
import { PhotoLightbox } from "@/components/photos/photo-lightbox";

const SUBCATEGORIES = ["All", "Progress", "Site Visit", "Damage", "Safety", "Delivery", "Other"] as const;

const DATE_RANGES = [
  { label: "All", value: "" },
  { label: "Today", value: "today" },
  { label: "This Week", value: "week" },
  { label: "This Month", value: "month" },
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

function formatDate(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function getDateKey(date: string): string {
  return new Date(date).toISOString().split("T")[0]; // YYYY-MM-DD
}

function getDateRange(range: string): { dateFrom?: string; dateTo?: string } {
  if (!range) return {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (range) {
    case "today": return { dateFrom: today.toISOString() };
    case "week": {
      const ws = new Date(today);
      ws.setDate(today.getDate() - today.getDay());
      return { dateFrom: ws.toISOString() };
    }
    case "month": return { dateFrom: new Date(today.getFullYear(), today.getMonth(), 1).toISOString() };
    default: return {};
  }
}

// ─── Thumbnail Hook ─────────────────────────────────────────────────────────

/** Cache presigned download URLs so we don't re-fetch per render */
const thumbCache = new Map<string, string>();

function useThumbnailUrl(photo: FeedPhoto): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    if (photo.externalThumbnailUrl) return photo.externalThumbnailUrl;
    if (photo.externalUrl) return photo.externalUrl;
    return thumbCache.get(photo.id) ?? null;
  });

  useEffect(() => {
    if (url) return; // Already have a URL
    let cancelled = false;

    api<{ url: string }>(`/files/${photo.id}/download`)
      .then((data) => {
        thumbCache.set(photo.id, data.url);
        if (!cancelled) setUrl(data.url);
      })
      .catch(() => {}); // Silently fail — show placeholder

    return () => { cancelled = true; };
  }, [photo.id, url]);

  return url;
}

// ─── Photo Card ─────────────────────────────────────────────────────────────

function PhotoCard({ photo, onClick }: { photo: FeedPhoto; onClick: () => void }) {
  const thumbUrl = useThumbnailUrl(photo);

  return (
    <div className="cursor-pointer group" onClick={onClick}>
      <div className="rounded-lg overflow-hidden bg-muted border border-border hover:border-[#CC0000]/40 transition-colors">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={photo.dealName || photo.displayName}
            loading="lazy"
            className="w-full h-48 object-cover group-hover:opacity-90 transition-opacity"
          />
        ) : (
          <div className="w-full h-48 flex items-center justify-center bg-muted">
            <ImageIcon className="h-10 w-10 text-muted-foreground/50" />
          </div>
        )}

        <div className="px-2.5 py-2 space-y-0.5">
          {photo.dealName && (
            <p className="text-xs font-semibold text-foreground truncate">{photo.dealName}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            {photo.uploaderName && (
              <span className="text-[11px] text-muted-foreground truncate">{photo.uploaderName}</span>
            )}
            <span className="text-[11px] text-muted-foreground shrink-0">
              {timeAgo(photo.takenAt || photo.createdAt)}
            </span>
          </div>
          {photo.subcategory && (
            <Badge variant="secondary" className="bg-[#CC0000]/10 text-[#CC0000] text-[10px] h-4 px-1.5">
              {photo.subcategory}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Grouped Photos ─────────────────────────────────────────────────────────

interface PhotoGroup {
  projectName: string;
  dealNumber: string | null;
  dateLabel: string;
  dateKey: string;
  photos: { photo: FeedPhoto; globalIndex: number }[];
}

function groupPhotos(photos: FeedPhoto[]): PhotoGroup[] {
  // Group by project + date
  const map = new Map<string, PhotoGroup>();

  photos.forEach((photo, index) => {
    const dateKey = getDateKey(photo.takenAt || photo.createdAt);
    const project = photo.dealName || "Unassigned";
    const key = `${project}__${dateKey}`;

    if (!map.has(key)) {
      map.set(key, {
        projectName: project,
        dealNumber: photo.dealNumber,
        dateLabel: formatDate(photo.takenAt || photo.createdAt),
        dateKey,
        photos: [],
      });
    }
    map.get(key)!.photos.push({ photo, globalIndex: index });
  });

  // Sort by date desc, then project name
  return Array.from(map.values()).sort((a, b) => {
    const dateCmp = b.dateKey.localeCompare(a.dateKey);
    if (dateCmp !== 0) return dateCmp;
    return a.projectName.localeCompare(b.projectName);
  });
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function PhotoFeedPage() {
  const [selectedSubcategory, setSelectedSubcategory] = useState("All");
  const [selectedDateRange, setSelectedDateRange] = useState("");
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);

  const filters = useMemo<FeedFilters>(() => {
    const f: FeedFilters = {};
    if (selectedSubcategory !== "All") f.subcategory = selectedSubcategory.toLowerCase();
    const dr = getDateRange(selectedDateRange);
    if (dr.dateFrom) f.dateFrom = dr.dateFrom;
    if (dr.dateTo) f.dateTo = dr.dateTo;
    return f;
  }, [selectedSubcategory, selectedDateRange]);

  const { photos, page, totalPages, total, loading, newCount, loadNewPhotos, goToPage } =
    usePhotoFeed(filters);

  const groups = useMemo(() => groupPhotos(photos), [photos]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Photo Feed</h1>
          <Badge variant="secondary" className="bg-[#CC0000]/10 text-[#CC0000] font-semibold">
            {total}
          </Badge>
          <Link to="/photos/capture" className="ml-auto">
            <Button size="sm" className="bg-[#CC0000] hover:bg-[#B00000] text-white">
              <Camera className="h-4 w-4 mr-2" />
              Capture
            </Button>
          </Link>
        </div>
      </div>

      {/* New photos banner */}
      {newCount > 0 && (
        <div className="sticky top-0 z-30 mx-6 mb-3 flex items-center justify-between rounded-lg bg-[#CC0000] px-4 py-2.5 text-white text-sm font-medium shadow-lg">
          <span>
            <RefreshCw className="inline h-4 w-4 mr-1.5 -mt-0.5" />
            {newCount} new photo{newCount !== 1 ? "s" : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={loadNewPhotos}
            className="border-white/40 text-white hover:bg-white/20 hover:text-white h-7 text-xs"
          >
            Load
          </Button>
        </div>
      )}

      {/* Filter bar */}
      <div className="sticky top-0 z-20 bg-background border-b px-6 py-3 space-y-3">
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {SUBCATEGORIES.map((sub) => (
            <button
              key={sub}
              type="button"
              onClick={() => setSelectedSubcategory(sub)}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                selectedSubcategory === sub
                  ? "bg-[#CC0000] text-white"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {sub}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {DATE_RANGES.map((dr) => (
            <button
              key={dr.value}
              type="button"
              onClick={() => setSelectedDateRange(dr.value)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                selectedDateRange === dr.value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {dr.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : photos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="rounded-full bg-muted p-6 mb-4">
              <Camera className="h-12 w-12 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold mb-1">No photos yet</h2>
            <p className="text-sm text-muted-foreground mb-4">Start capturing photos from the field</p>
            <Link to="/photos/capture">
              <Button className="bg-[#CC0000] hover:bg-[#B00000] text-white">
                <Camera className="h-4 w-4 mr-2" />
                Capture Photos
              </Button>
            </Link>
          </div>
        ) : (
          <>
            {/* Grouped by project + date */}
            <div className="space-y-6">
              {groups.map((group) => (
                <div key={`${group.projectName}__${group.dateKey}`}>
                  {/* Group header */}
                  <div className="flex items-center gap-3 mb-3">
                    <h3 className="text-sm font-bold text-foreground">{group.projectName}</h3>
                    {group.dealNumber && (
                      <span className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {group.dealNumber}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">{group.dateLabel}</span>
                    <span className="text-xs text-muted-foreground">
                      ({group.photos.length} photo{group.photos.length !== 1 ? "s" : ""})
                    </span>
                  </div>

                  {/* Photo grid within group */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                    {group.photos.map(({ photo, globalIndex }) => (
                      <PhotoCard
                        key={photo.id}
                        photo={photo}
                        onClick={() => setSelectedPhotoIndex(globalIndex)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-6 border-t mt-6">
                <Button variant="outline" size="sm" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Prev
                </Button>
                <span className="text-sm text-muted-foreground font-medium">
                  Page {page} of {totalPages}
                </span>
                <Button variant="outline" size="sm" onClick={() => goToPage(page + 1)} disabled={page >= totalPages}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Lightbox */}
      {selectedPhotoIndex != null && photos[selectedPhotoIndex] && (
        <PhotoLightbox
          photo={photos[selectedPhotoIndex]}
          onClose={() => setSelectedPhotoIndex(null)}
          onPrev={selectedPhotoIndex > 0 ? () => setSelectedPhotoIndex((p) => p! - 1) : undefined}
          onNext={selectedPhotoIndex < photos.length - 1 ? () => setSelectedPhotoIndex((p) => p! + 1) : undefined}
        />
      )}
    </div>
  );
}
