import { useState, useMemo } from "react";
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
import { usePhotoFeed, type FeedFilters, type FeedPhoto } from "@/hooks/use-photo-feed";
import { PhotoLightbox } from "@/components/photos/photo-lightbox";

// ─── Constants ──────────────────────────────────────────────────────────────

const SUBCATEGORIES = [
  "All",
  "Progress",
  "Site Visit",
  "Damage",
  "Safety",
  "Delivery",
  "Other",
] as const;

const DATE_RANGES = [
  { label: "All", value: "" },
  { label: "Today", value: "today" },
  { label: "This Week", value: "week" },
  { label: "This Month", value: "month" },
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function getDateRange(range: string): { dateFrom?: string; dateTo?: string } {
  if (!range) return {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (range) {
    case "today":
      return { dateFrom: today.toISOString() };
    case "week": {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      return { dateFrom: weekStart.toISOString() };
    }
    case "month": {
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      return { dateFrom: monthStart.toISOString() };
    }
    default:
      return {};
  }
}

function getThumbnailUrl(photo: FeedPhoto): string | null {
  return photo.externalThumbnailUrl || photo.externalUrl || null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function PhotoFeedPage() {
  // Filter state
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>("All");
  const [selectedDateRange, setSelectedDateRange] = useState<string>("");

  // Lightbox state
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);

  // Build filters
  const filters = useMemo<FeedFilters>(() => {
    const f: FeedFilters = {};
    if (selectedSubcategory !== "All") {
      f.subcategory = selectedSubcategory.toLowerCase();
    }
    const dateRange = getDateRange(selectedDateRange);
    if (dateRange.dateFrom) f.dateFrom = dateRange.dateFrom;
    if (dateRange.dateTo) f.dateTo = dateRange.dateTo;
    return f;
  }, [selectedSubcategory, selectedDateRange]);

  const { photos, page, totalPages, total, loading, newCount, loadNewPhotos, goToPage } =
    usePhotoFeed(filters);

  // Lightbox navigation
  function openLightbox(index: number) {
    setSelectedPhotoIndex(index);
  }

  function closeLightbox() {
    setSelectedPhotoIndex(null);
  }

  function prevPhoto() {
    setSelectedPhotoIndex((prev) => {
      if (prev == null || prev <= 0) return prev;
      return prev - 1;
    });
  }

  function nextPhoto() {
    setSelectedPhotoIndex((prev) => {
      if (prev == null || prev >= photos.length - 1) return prev;
      return prev + 1;
    });
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Photo Feed</h1>
          <Badge variant="secondary" className="bg-[#CC0000]/10 text-[#CC0000] font-semibold">
            {total}
          </Badge>
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
        {/* Subcategory pills */}
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

        {/* Date range filter */}
        <div className="flex items-center gap-3 flex-wrap">
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
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : photos.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="rounded-full bg-muted p-6 mb-4">
              <Camera className="h-12 w-12 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold mb-1">No photos yet</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Start capturing photos from the field
            </p>
            <Link to="/photos/capture">
              <Button className="bg-[#CC0000] hover:bg-[#B00000] text-white">
                <Camera className="h-4 w-4 mr-2" />
                Capture Photos
              </Button>
            </Link>
          </div>
        ) : (
          <>
            {/* Masonry grid */}
            <div className="columns-2 sm:columns-3 lg:columns-4 xl:columns-5 gap-3">
              {photos.map((photo, index) => {
                const thumbUrl = getThumbnailUrl(photo);
                return (
                  <div
                    key={photo.id}
                    className="break-inside-avoid mb-3 cursor-pointer group"
                    onClick={() => openLightbox(index)}
                  >
                    <div className="rounded-lg overflow-hidden bg-muted border border-border hover:border-[#CC0000]/40 transition-colors">
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={photo.displayName}
                          loading="lazy"
                          className="w-full object-cover group-hover:opacity-90 transition-opacity"
                        />
                      ) : (
                        <div className="w-full aspect-square flex items-center justify-center bg-muted">
                          <ImageIcon className="h-10 w-10 text-muted-foreground/50" />
                        </div>
                      )}

                      <div className="px-2.5 py-2 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          {photo.dealNumber && (
                            <span className="text-xs font-medium text-foreground truncate">
                              {photo.dealNumber}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground shrink-0">
                            {timeAgo(photo.takenAt || photo.createdAt)}
                          </span>
                        </div>
                        {photo.uploaderName && (
                          <span className="text-[10px] text-muted-foreground truncate block">
                            {photo.uploaderName}
                          </span>
                        )}
                        {photo.subcategory && (
                          <Badge
                            variant="secondary"
                            className="bg-[#CC0000]/10 text-[#CC0000] text-[10px] h-4 px-1.5"
                          >
                            {photo.subcategory}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-6 border-t mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Prev
                </Button>
                <span className="text-sm text-muted-foreground font-medium">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages}
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
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
          onClose={closeLightbox}
          onPrev={selectedPhotoIndex > 0 ? prevPhoto : undefined}
          onNext={selectedPhotoIndex < photos.length - 1 ? nextPhoto : undefined}
        />
      )}
    </div>
  );
}
