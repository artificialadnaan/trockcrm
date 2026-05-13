import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, FileText, MapPin, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api } from "@/lib/api";

interface PublicPhoto {
  id: string;
  displayName: string;
  mimeType: string;
  fileExtension: string | null;
  description: string | null;
  photoCategory: string | null;
  subcategory: string | null;
  takenAt: string | null;
  createdAt: string;
  uploaderName: string;
  latitude: string | null;
  longitude: string | null;
  address: string | null;
  addressSource: string | null;
  imageUrl: string | null;
}

interface PublicViewerResponse {
  deal: {
    id: string;
    name: string;
    dealNumber: string | null;
    propertyAddress: string | null;
  };
  photos: PublicPhoto[];
}

function groupByDate(photos: PublicPhoto[]) {
  return photos.reduce<Array<{ label: string; photos: PublicPhoto[] }>>((groups, photo) => {
    const date = new Date(photo.takenAt ?? photo.createdAt);
    const label = date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const existing = groups.find((group) => group.label === label);
    if (existing) existing.photos.push(photo);
    else groups.push({ label, photos: [photo] });
    return groups;
  }, []);
}

function categoryLabel(photo: PublicPhoto) {
  return photo.photoCategory?.replace(/_/g, " ") ?? photo.subcategory?.replace(/_/g, " ") ?? null;
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

  const groups = useMemo(() => groupByDate(data?.photos ?? []), [data?.photos]);
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

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 sm:px-6">
        {photos.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No photos have been shared yet.
          </div>
        ) : groups.map((group) => (
          <section key={group.label} className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">{group.label}</h2>
              <p className="text-xs text-slate-500">{group.photos.length} photos</p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {group.photos.map((photo) => (
                <button
                  key={photo.id}
                  type="button"
                  className="overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                  onClick={() => setSelectedId(photo.id)}
                >
                  <div className="flex aspect-square items-center justify-center bg-slate-200">
                    {photo.imageUrl ? (
                      <img src={photo.imageUrl} alt={photo.displayName} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <FileText className="h-8 w-8 text-slate-400" />
                    )}
                  </div>
                  <div className="space-y-1 p-2">
                    <p className="truncate text-sm font-medium">{photo.displayName}</p>
                    <p className="truncate text-xs text-slate-500">{photo.uploaderName}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <Dialog open={Boolean(selectedPhoto)} onOpenChange={(open) => !open && setSelectedId(null)}>
        {selectedPhoto && (
          <DialogContent className="max-w-5xl overflow-hidden p-0">
            <div className="grid max-h-[90vh] bg-black md:grid-cols-[1fr_22rem]">
              <div className="relative flex min-h-[60vh] items-center justify-center">
                <button type="button" className="absolute right-3 top-3 rounded-full bg-black/70 p-2 text-white" onClick={() => setSelectedId(null)}>
                  <X className="h-5 w-5" />
                </button>
                {selectedPhoto.imageUrl ? (
                  <img src={selectedPhoto.imageUrl} alt={selectedPhoto.displayName} className="max-h-[90vh] max-w-full object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-3 px-6 text-center text-white">
                    <FileText className="h-12 w-12 text-white/75" />
                    <div>
                      <p className="text-sm font-medium">No image preview available</p>
                      <p className="mt-1 text-xs text-white/70">{selectedPhoto.mimeType || selectedPhoto.fileExtension || "File attachment"}</p>
                    </div>
                  </div>
                )}
                <Button className="absolute left-3 top-1/2" variant="secondary" size="icon" disabled={selectedIndex <= 0} onClick={() => setSelectedId(photos[selectedIndex - 1]?.id)}>
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <Button className="absolute right-3 top-1/2" variant="secondary" size="icon" disabled={selectedIndex >= photos.length - 1} onClick={() => setSelectedId(photos[selectedIndex + 1]?.id)}>
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </div>
              <aside className="space-y-4 overflow-y-auto bg-white p-4">
                <div>
                  <h2 className="text-lg font-semibold">{selectedPhoto.displayName}</h2>
                  <p className="text-sm text-slate-500">{selectedPhoto.description ?? "No caption"}</p>
                </div>
                {categoryLabel(selectedPhoto) && <Badge variant="outline">{categoryLabel(selectedPhoto)}</Badge>}
                <dl className="space-y-2 text-sm">
                  <div><dt className="text-xs uppercase text-slate-500">Uploaded by</dt><dd>{selectedPhoto.uploaderName}</dd></div>
                  <div><dt className="text-xs uppercase text-slate-500">Taken</dt><dd>{selectedPhoto.takenAt ? new Date(selectedPhoto.takenAt).toLocaleString() : "Not recorded"}</dd></div>
                  <div><dt className="text-xs uppercase text-slate-500">Address</dt><dd>{selectedPhoto.address ?? "No address recorded"}</dd></div>
                </dl>
                <Button className="w-full" onClick={() => downloadPhoto(selectedPhoto.id)}>
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </Button>
              </aside>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
