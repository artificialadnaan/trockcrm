import { useState, useEffect, useCallback } from "react";
import { X, ChevronLeft, ChevronRight, Download, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import type { FeedPhoto } from "@/hooks/use-photo-feed";

interface PhotoLightboxProps {
  photo: FeedPhoto;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PhotoLightbox({ photo, onClose, onPrev, onNext }: PhotoLightboxProps) {
  const [fullResUrl, setFullResUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadFullRes() {
      if (photo.externalUrl) {
        setFullResUrl(photo.externalUrl);
        setLoadingUrl(false);
        return;
      }
      try {
        const data = await api<{ url: string; filename: string }>(
          `/files/${photo.id}/download`
        );
        if (!cancelled) {
          setFullResUrl(data.url);
        }
      } catch (err) {
        console.error("Failed to load full-res image:", err);
        // Fall back to thumbnail
        if (!cancelled) {
          setFullResUrl(photo.externalThumbnailUrl);
        }
      } finally {
        if (!cancelled) setLoadingUrl(false);
      }
    }

    setLoadingUrl(true);
    loadFullRes();
    return () => { cancelled = true; };
  }, [photo.id, photo.externalUrl, photo.externalThumbnailUrl]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      if (e.key === "ArrowRight" && onNext) onNext();
    },
    [onClose, onPrev, onNext]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Prevent body scroll while lightbox is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  function handleDownload() {
    if (!fullResUrl) return;
    const a = document.createElement("a");
    a.href = fullResUrl;
    a.download = photo.displayName || "photo";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-50 rounded-full bg-black/60 p-2 text-white/80 hover:text-white transition-colors"
      >
        <X className="h-6 w-6" />
      </button>

      {/* Image area */}
      <div className="flex-1 flex items-center justify-center relative min-h-0 px-12">
        {/* Prev arrow */}
        {onPrev && (
          <button
            onClick={(e) => { e.stopPropagation(); onPrev(); }}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-50 rounded-full bg-black/60 p-2 text-white/70 hover:text-white transition-colors"
          >
            <ChevronLeft className="h-8 w-8" />
          </button>
        )}

        {loadingUrl ? (
          <div className="text-white/50 text-sm">Loading...</div>
        ) : fullResUrl ? (
          <img
            src={fullResUrl}
            alt={photo.displayName}
            className="max-h-full max-w-full object-contain select-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="text-white/50 text-sm">Image unavailable</div>
        )}

        {/* Next arrow */}
        {onNext && (
          <button
            onClick={(e) => { e.stopPropagation(); onNext(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-50 rounded-full bg-black/60 p-2 text-white/70 hover:text-white transition-colors"
          >
            <ChevronRight className="h-8 w-8" />
          </button>
        )}
      </div>

      {/* Metadata bar */}
      <div
        className="shrink-0 border-t border-white/10 bg-black/80 px-4 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-w-3xl mx-auto flex flex-wrap items-center gap-3 text-sm text-white/70">
          <span className="font-medium text-white">
            {formatDate(photo.takenAt || photo.createdAt)}
          </span>

          {photo.subcategory && (
            <Badge variant="secondary" className="bg-[#CC0000]/20 text-[#CC0000] border-[#CC0000]/30">
              {photo.subcategory}
            </Badge>
          )}

          {photo.dealId && (
            <span className="text-white/50">
              Deal: {photo.dealId}
            </span>
          )}

          <span className="text-white/50">
            By: {photo.uploadedBy}
          </span>

          {photo.geoLat != null && photo.geoLng != null && (
            <a
              href={`https://www.google.com/maps?q=${photo.geoLat},${photo.geoLng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[#CC0000] hover:text-[#FF4444] transition-colors"
            >
              <MapPin className="h-3.5 w-3.5" />
              Map
            </a>
          )}

          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              disabled={!fullResUrl}
              className="border-white/20 text-white hover:bg-white/10 hover:text-white h-8"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
