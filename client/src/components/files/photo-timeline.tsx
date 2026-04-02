import { useState, useMemo } from "react";
import { Camera, Download, X, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useDealPhotos, downloadFile } from "@/hooks/use-files";
import type { FileRecord } from "@/hooks/use-files";

interface PhotoTimelineProps {
  dealId: string;
}

function getPhotoDate(photo: FileRecord): Date {
  return new Date(photo.takenAt ?? photo.createdAt);
}

function formatDateHeading(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function PhotoTimeline({ dealId }: PhotoTimelineProps) {
  const [page, setPage] = useState(1);
  const { photos, pagination, loading, error } = useDealPhotos(dealId, page);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Group photos by date
  const groupedPhotos = useMemo(() => {
    const groups = new Map<string, FileRecord[]>();
    for (const photo of photos) {
      const dateKey = getPhotoDate(photo).toISOString().split("T")[0];
      const existing = groups.get(dateKey) ?? [];
      existing.push(photo);
      groups.set(dateKey, existing);
    }
    return Array.from(groups.entries()).map(([date, items]) => ({
      date,
      heading: formatDateHeading(new Date(date)),
      photos: items,
    }));
  }, [photos]);

  if (loading) {
    return (
      <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="aspect-square bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm py-4">{error}</p>;
  }

  if (photos.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Camera className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No photos uploaded yet.</p>
        <p className="text-xs mt-1">Upload photos to see them in the timeline.</p>
      </div>
    );
  }

  // Build a flat index for lightbox navigation
  const flatPhotos = groupedPhotos.flatMap((g) => g.photos);

  return (
    <div className="space-y-6">
      {groupedPhotos.map((group) => (
        <div key={group.date}>
          <h4 className="text-sm font-semibold text-muted-foreground mb-2">
            {group.heading}
            <span className="ml-2 text-xs font-normal">
              ({group.photos.length} photo{group.photos.length !== 1 ? "s" : ""})
            </span>
          </h4>
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {group.photos.map((photo) => {
              const flatIdx = flatPhotos.indexOf(photo);
              return (
                <button
                  key={photo.id}
                  className="relative aspect-square rounded-lg overflow-hidden group border hover:ring-2 hover:ring-brand-purple transition-all"
                  onClick={() => setLightboxIndex(flatIdx)}
                >
                  {/* Thumbnail placeholder -- R2 public URLs not available */}
                  <div className="w-full h-full bg-muted flex items-center justify-center">
                    <Camera className="h-6 w-6 text-muted-foreground/50" />
                  </div>
                  {/* Overlay on hover */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-end">
                    <div className="w-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <p className="text-[10px] text-white truncate">{photo.displayName}</p>
                    </div>
                  </div>
                  {/* Subcategory badge */}
                  {photo.subcategory && (
                    <Badge
                      variant="secondary"
                      className="absolute top-1 left-1 text-[9px] px-1 py-0 opacity-80"
                    >
                      {photo.subcategory}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} photos)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setPage(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Lightbox Overlay */}
      {lightboxIndex !== null && flatPhotos[lightboxIndex] && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxIndex(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute -top-12 right-0 text-white hover:bg-white/20"
              onClick={() => setLightboxIndex(null)}
            >
              <X className="h-6 w-6" />
            </Button>

            {/* Navigation */}
            {lightboxIndex > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 text-white hover:bg-white/20"
                onClick={() => setLightboxIndex(lightboxIndex - 1)}
              >
                <ChevronLeft className="h-8 w-8" />
              </Button>
            )}
            {lightboxIndex < flatPhotos.length - 1 && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-12 text-white hover:bg-white/20"
                onClick={() => setLightboxIndex(lightboxIndex + 1)}
              >
                <ChevronRight className="h-8 w-8" />
              </Button>
            )}

            {/* Photo Content */}
            <div className="bg-black rounded-lg overflow-hidden flex items-center justify-center min-h-[50vh]">
              <div className="text-center text-white/60">
                <Camera className="h-16 w-16 mx-auto mb-2" />
                <p className="text-sm">
                  {flatPhotos[lightboxIndex].displayName}
                  {flatPhotos[lightboxIndex].fileExtension}
                </p>
              </div>
            </div>

            {/* Info Bar */}
            <div className="mt-3 flex items-center justify-between text-white/80 text-sm">
              <div className="flex items-center gap-3">
                <span>{flatPhotos[lightboxIndex].displayName}</span>
                {flatPhotos[lightboxIndex].subcategory && (
                  <Badge variant="secondary" className="text-xs">
                    {flatPhotos[lightboxIndex].subcategory}
                  </Badge>
                )}
                {flatPhotos[lightboxIndex].geoLat && (
                  <span className="flex items-center gap-1 text-xs">
                    <MapPin className="h-3 w-3" />
                    GPS
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-white hover:bg-white/20"
                onClick={() => downloadFile(flatPhotos[lightboxIndex!].id)}
              >
                <Download className="h-4 w-4 mr-1" />
                Download
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
