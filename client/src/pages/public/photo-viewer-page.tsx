import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, FileText, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api } from "@/lib/api";

// Mirrors the locked public payload (server: public-photo-tokens). The public surface
// exposes ONLY the photos and the property name/address — never the uploader, category,
// caption, timestamps, file metadata, or internal ids.
interface PublicPhoto {
  id: string;
  imageUrl: string | null;
}

interface PublicViewerResponse {
  deal: {
    name: string;
    propertyAddress: string | null;
  };
  photos: PublicPhoto[];
}

export function PublicPhotoViewerPage() {
  const { token } = useParams();
  const [data, setData] = useState<PublicViewerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api<PublicViewerResponse>(`/public/photo-viewer/${encodeURIComponent(token ?? "")}`)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch(() => {
        if (!cancelled) setError("This photo link is no longer valid.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const photos = data?.photos ?? [];
  const selectedIndex = photos.findIndex((photo) => photo.id === selectedId);
  const selectedPhoto = selectedIndex >= 0 ? photos[selectedIndex] : null;

  async function downloadPhoto(photoId: string) {
    const response = await api<{ url: string }>(
      `/public/photo-viewer/${encodeURIComponent(token ?? "")}/photos/${encodeURIComponent(photoId)}/download`
    );
    window.open(response.url, "_blank", "noopener,noreferrer");
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">Loading photos...</div>;
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-red-700">Photo link unavailable</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">This link is no longer valid.</h1>
          <p className="mt-2 text-sm text-slate-600">Please contact T Rock for a new photo link.</p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-red-700">T Rock Photos</p>
        <h1 className="mt-1 text-2xl font-semibold">{data.deal.name}</h1>
        {data.deal.propertyAddress && (
          <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
            <MapPin className="h-4 w-4" />
            {data.deal.propertyAddress}
          </p>
        )}
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {photos.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No photos have been shared yet.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {photos.map((photo, index) => (
              <button
                key={photo.id}
                type="button"
                // Indexed, leak-free name: keeps each thumbnail distinct for assistive tech and
                // role/name automation without exposing the photo's display name or any metadata.
                aria-label={`Shared photo ${index + 1}`}
                className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                onClick={() => setSelectedId(photo.id)}
              >
                <div className="flex aspect-square items-center justify-center bg-slate-200">
                  {photo.imageUrl ? (
                    <img src={photo.imageUrl} alt={`Shared photo ${index + 1}`} className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <FileText className="h-8 w-8 text-slate-400" />
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Dialog open={Boolean(selectedPhoto)} onOpenChange={(open) => !open && setSelectedId(null)}>
        {selectedPhoto && (
          <DialogContent className="max-w-5xl overflow-hidden bg-black p-0">
            <div className="relative flex max-h-[90vh] min-h-[60vh] items-center justify-center">
              <button
                type="button"
                className="absolute right-3 top-3 z-10 rounded-full bg-black/70 p-2 text-white"
                onClick={() => setSelectedId(null)}
              >
                <X className="h-5 w-5" />
              </button>
              {selectedPhoto.imageUrl ? (
                <img src={selectedPhoto.imageUrl} alt={`Shared photo ${selectedIndex + 1}`} className="max-h-[90vh] max-w-full object-contain" />
              ) : (
                <div className="flex flex-col items-center gap-3 px-6 text-center text-white">
                  <FileText className="h-12 w-12 text-white/75" />
                  <p className="text-sm font-medium">No image preview available</p>
                </div>
              )}
              <Button
                className="absolute left-3 top-1/2"
                variant="secondary"
                size="icon"
                disabled={selectedIndex <= 0}
                onClick={() => setSelectedId(photos[selectedIndex - 1]?.id)}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                className="absolute right-3 top-1/2"
                variant="secondary"
                size="icon"
                disabled={selectedIndex >= photos.length - 1}
                onClick={() => setSelectedId(photos[selectedIndex + 1]?.id)}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
              {selectedPhoto.imageUrl && (
                <Button className="absolute bottom-3 right-3" onClick={() => downloadPhoto(selectedPhoto.id)}>
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </Button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
