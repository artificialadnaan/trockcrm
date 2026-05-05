import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  History,
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

export type PhotoGrouping = "date" | "category" | "uploader" | "none";
export type PhotoCategory =
  | "before"
  | "after"
  | "progress"
  | "site_visit"
  | "damage"
  | "safety"
  | "delivery"
  | "other";

export interface DealPhotoRecord {
  id: string;
  category: "photo";
  photoCategory: PhotoCategory | null;
  subcategory: string | null;
  displayName: string;
  mimeType: string;
  r2Key: string;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
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
}

export interface PhotoFilterState {
  categories: string[];
  uploaderIds: string[];
  from: string;
  to: string;
  group: PhotoGrouping;
  showDeleted: boolean;
}

const PHOTO_CATEGORIES: Array<{ value: PhotoCategory; label: string }> = [
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "progress", label: "Progress" },
  { value: "site_visit", label: "Site Visit" },
  { value: "damage", label: "Damage" },
  { value: "safety", label: "Safety" },
  { value: "delivery", label: "Delivery" },
  { value: "other", label: "Other" },
];

const GROUP_OPTIONS: Array<{ value: PhotoGrouping; label: string }> = [
  { value: "date", label: "Date" },
  { value: "category", label: "Category" },
  { value: "uploader", label: "Uploader" },
  { value: "none", label: "None" },
];

function ordinal(day: number) {
  if (day > 3 && day < 21) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

function formatDateHeading(value: string) {
  const date = new Date(value);
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const month = date.toLocaleDateString("en-US", { month: "long" });
  return `${weekday}, ${month} ${ordinal(date.getDate())}, ${date.getFullYear()}`;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function displayPhotoCategory(photo: DealPhotoRecord): string | null {
  if (photo.photoCategory) {
    return PHOTO_CATEGORIES.find((category) => category.value === photo.photoCategory)?.label ?? photo.photoCategory;
  }
  if (photo.subcategory) return photo.subcategory.replace(/_/g, " ");
  return null;
}

function photoSortTime(photo: DealPhotoRecord) {
  return new Date(photo.takenAt ?? photo.createdAt).getTime();
}

export function buildPhotoFilterSearchParams(filters: PhotoFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.categories.length > 0) params.set("category", filters.categories.join(","));
  if (filters.uploaderIds.length > 0) params.set("uploader", filters.uploaderIds.join(","));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.group !== "date") params.set("group", filters.group);
  if (filters.showDeleted) params.set("deleted", "1");
  return params;
}

function filtersFromSearchParams(params: URLSearchParams): PhotoFilterState {
  const group = params.get("group");
  return {
    categories: params.get("category")?.split(",").filter(Boolean) ?? [],
    uploaderIds: params.get("uploader")?.split(",").filter(Boolean) ?? [],
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    group: group === "category" || group === "uploader" || group === "none" ? group : "date",
    showDeleted: params.get("deleted") === "1" || params.get("deleted") === "true",
  };
}

function matchesFilters(photo: DealPhotoRecord, filters: PhotoFilterState) {
  if (!filters.showDeleted && photo.deletedAt) return false;
  if (filters.categories.length > 0) {
    const category = photo.photoCategory ?? (photo.subcategory ? photo.subcategory.toLowerCase().replace(/\s+/g, "_") : "uncategorized");
    if (!filters.categories.includes(category)) return false;
  }
  if (filters.uploaderIds.length > 0 && !filters.uploaderIds.includes(photo.uploadedBy)) return false;
  const day = new Date(photo.takenAt ?? photo.createdAt).toISOString().slice(0, 10);
  if (filters.from && day < filters.from) return false;
  if (filters.to && day > filters.to) return false;
  return true;
}

export function groupDealPhotos(photos: DealPhotoRecord[], filters: PhotoFilterState) {
  const visible = photos.filter((photo) => matchesFilters(photo, filters)).sort((a, b) => photoSortTime(b) - photoSortTime(a));
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

export function DealPhotosTab({ dealId, onCountChange }: { dealId: string; onCountChange?: (count: number) => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => filtersFromSearchParams(searchParams));
  const [photos, setPhotos] = useState<DealPhotoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deletePhoto, setDeletePhoto] = useState<DealPhotoRecord | null>(null);
  const [addressDraft, setAddressDraft] = useState({ address: "", latitude: "", longitude: "" });
  const [captionDraft, setCaptionDraft] = useState("");
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    setFilters(filtersFromSearchParams(searchParams));
  }, [searchParams]);

  const fetchPhotos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: "1", limit: "200" });
      const filterParams = buildPhotoFilterSearchParams(filters);
      filterParams.forEach((value, key) => params.set(key, value));
      const data = await api<{ photos: DealPhotoRecord[]; pagination: { total: number } }>(`/files/deal/${dealId}/photos?${params}`);
      setPhotos(data.photos);
      onCountChange?.(data.photos.filter((photo) => !photo.deletedAt).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      setLoading(false);
    }
  }, [dealId, filters, onCountChange]);

  useEffect(() => {
    void fetchPhotos();
  }, [fetchPhotos]);

  useEffect(() => {
    const missingPreviewUrls = photos.filter((photo) => !photo.externalThumbnailUrl && !photo.externalUrl && !downloadUrls[photo.id]);
    if (missingPreviewUrls.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missingPreviewUrls.map(async (photo) => {
        try {
          const data = await api<{ url: string }>(`/files/${photo.id}/download`);
          return [photo.id, data.url] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      const next = Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, string]>);
      if (Object.keys(next).length > 0) {
        setDownloadUrls((current) => ({ ...current, ...next }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [downloadUrls, photos]);

  const updateFilters = (next: PhotoFilterState) => {
    setFilters(next);
    const nextParams = new URLSearchParams(searchParams);
    ["category", "uploader", "from", "to", "group", "deleted"].forEach((key) => nextParams.delete(key));
    buildPhotoFilterSearchParams(next).forEach((value, key) => nextParams.set(key, value));
    setSearchParams(nextParams, { replace: true });
  };

  const activeFilters = filters.categories.length + filters.uploaderIds.length + (filters.from ? 1 : 0) + (filters.to ? 1 : 0) + (filters.showDeleted ? 1 : 0);
  const uploaders = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatarUrl: string | null }>();
    photos.forEach((photo) => map.set(photo.uploadedBy, { id: photo.uploadedBy, name: photo.uploaderName, avatarUrl: photo.uploaderAvatarUrl }));
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [photos]);
  const groups = useMemo(() => groupDealPhotos(photos, filters), [photos, filters]);
  const flatPhotos = groups.flatMap((group) => group.photos);
  const selectedIndex = selectedId ? flatPhotos.findIndex((photo) => photo.id === selectedId) : -1;
  const selectedPhoto = selectedIndex >= 0 ? flatPhotos[selectedIndex] : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!selectedPhoto) return;
      if (event.key === "ArrowLeft" && selectedIndex > 0) setSelectedId(flatPhotos[selectedIndex - 1].id);
      if (event.key === "ArrowRight" && selectedIndex < flatPhotos.length - 1) setSelectedId(flatPhotos[selectedIndex + 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flatPhotos, selectedIndex, selectedPhoto]);

  async function patchPhoto(photoId: string, body: Record<string, unknown>) {
    const { file } = await api<{ file: DealPhotoRecord }>(`/files/${photoId}`, { method: "PATCH", json: body });
    setPhotos((current) => current.map((photo) => (photo.id === photoId ? { ...photo, ...file } : photo)));
  }

  const getPhotoImageUrl = useCallback((photo: DealPhotoRecord) => {
    return photo.externalThumbnailUrl ?? photo.externalUrl ?? downloadUrls[photo.id] ?? "";
  }, [downloadUrls]);

  async function saveAddress(photo: DealPhotoRecord) {
    const { file } = await api<{ file: DealPhotoRecord }>(`/files/${photo.id}/address`, {
      method: "PATCH",
      json: {
        address: addressDraft.address,
        latitude: addressDraft.latitude ? Number(addressDraft.latitude) : undefined,
        longitude: addressDraft.longitude ? Number(addressDraft.longitude) : undefined,
      },
    });
    setPhotos((current) => current.map((item) => (item.id === photo.id ? { ...item, ...file } : item)));
  }

  async function confirmDelete(photo: DealPhotoRecord) {
    await api(`/files/${photo.id}`, { method: "DELETE" });
    setDeletePhoto(null);
    setSelectedId(null);
    await fetchPhotos();
  }

  async function restorePhoto(photo: DealPhotoRecord) {
    await patchPhoto(photo.id, { deletedAt: null, deletedByUserId: null });
    await fetchPhotos();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Photos</h3>
          <p className="text-sm text-muted-foreground">Project photo history, location context, and field documentation.</p>
        </div>
        <Button nativeButton={false} render={<Link to={`/photos/capture?dealId=${encodeURIComponent(dealId)}`} />} size="sm">
            <Upload className="mr-1.5 h-4 w-4" />
            Upload
        </Button>
      </div>

      <div data-testid="photo-filter-bar" className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
        <MultiSelectButton
          label="Category"
          selectedCount={filters.categories.length}
          options={[...PHOTO_CATEGORIES, { value: "uncategorized", label: "Uncategorized" }]}
          selected={filters.categories}
          onChange={(categories) => updateFilters({ ...filters, categories })}
        />
        <MultiSelectButton
          label="Uploader"
          selectedCount={filters.uploaderIds.length}
          options={uploaders.map((uploader) => ({ value: uploader.id, label: uploader.name, avatarUrl: uploader.avatarUrl }))}
          selected={filters.uploaderIds}
          onChange={(uploaderIds) => updateFilters({ ...filters, uploaderIds })}
        />
        <div className="flex items-center gap-1">
          <DateField value={filters.from} onChange={(from) => updateFilters({ ...filters, from })} className="h-8 w-[9rem]" />
          <span className="text-xs text-muted-foreground">to</span>
          <DateField value={filters.to} onChange={(to) => updateFilters({ ...filters, to })} className="h-8 w-[9rem]" />
        </div>
        <div className="flex rounded-md border bg-background p-0.5">
          {GROUP_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={`Group by ${option.label}`}
              className={`rounded px-2.5 py-1 text-xs font-medium ${filters.group === option.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateFilters({ ...filters, group: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant={filters.showDeleted ? "default" : "outline"}
          size="sm"
          aria-label="Show deleted photos"
          onClick={() => updateFilters({ ...filters, showDeleted: !filters.showDeleted })}
        >
          Deleted
        </Button>
        {activeFilters > 0 && (
          <Button variant="ghost" size="sm" onClick={() => updateFilters({ categories: [], uploaderIds: [], from: "", to: "", group: "date", showDeleted: false })}>
            <X className="mr-1 h-4 w-4" />
            Clear filters
          </Button>
        )}
      </div>

      {loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, index) => <div key={index} className="aspect-square animate-pulse rounded-lg bg-muted" />)}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <Button className="ml-3" variant="outline" size="sm" onClick={fetchPhotos}>Retry</Button>
        </div>
      )}

      {!loading && !error && flatPhotos.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-14 text-center">
          <Camera className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">No photos have been added to this project yet</p>
          <Button nativeButton={false} render={<Link to={`/photos/capture?dealId=${encodeURIComponent(dealId)}`} />} className="mt-4">
            Upload photos
          </Button>
        </div>
      )}

      {!loading && !error && groups.map((group) => (
        <section key={group.label} className="space-y-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <CalendarDays className="h-4 w-4" />
            {group.label}
            <span className="text-xs font-normal">({group.photos.length})</span>
          </h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            {group.photos.map((photo) => (
              <PhotoTile key={photo.id} photo={photo} imageUrl={getPhotoImageUrl(photo)} onOpen={() => setSelectedId(photo.id)} onRestore={() => restorePhoto(photo)} />
            ))}
          </div>
        </section>
      ))}

      <Dialog open={Boolean(selectedPhoto)} onOpenChange={(open) => !open && setSelectedId(null)}>
        {selectedPhoto && (
          <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="flex min-h-[45vh] items-center justify-center rounded-lg bg-black">
                <img
                  src={getPhotoImageUrl(selectedPhoto)}
                  alt={selectedPhoto.displayName}
                  className="max-h-[72vh] max-w-full object-contain"
                />
              </div>
              <div className="space-y-4">
                <DialogHeader>
                  <DialogTitle>{selectedPhoto.description || selectedPhoto.displayName}</DialogTitle>
                  <DialogDescription>{formatTime(selectedPhoto.takenAt ?? selectedPhoto.createdAt)} · {selectedPhoto.uploaderName}</DialogDescription>
                </DialogHeader>

                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Caption</span>
                    <Popover>
                      <PopoverTrigger
                        render={<Button variant="ghost" size="sm" onClick={() => setCaptionDraft(selectedPhoto.description ?? "")}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>}
                      />
                      <PopoverContent align="end" className="space-y-2">
                        <Input value={captionDraft} onChange={(event) => setCaptionDraft(event.target.value)} placeholder="Caption" />
                        <Button size="sm" onClick={() => patchPhoto(selectedPhoto.id, { description: captionDraft.trim() || null })}>Save caption</Button>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <p className="text-sm text-muted-foreground">{selectedPhoto.description || "No caption"}</p>
                </section>

                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</span>
                    <Popover>
                      <PopoverTrigger render={<Button variant="ghost" size="sm"><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>} />
                      <PopoverContent align="end">
                        <div className="grid gap-1">
                          {[...PHOTO_CATEGORIES, { value: null, label: "Clear category" }].map((category) => (
                            <button
                              key={category.label}
                              type="button"
                              className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                              onClick={() => patchPhoto(selectedPhoto.id, { photoCategory: category.value })}
                            >
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
                    <Avatar className="h-8 w-8"><AvatarImage src={selectedPhoto.uploaderAvatarUrl ?? undefined} /><AvatarFallback>{initials(selectedPhoto.uploaderName)}</AvatarFallback></Avatar>
                    <div>
                      <p className="font-medium">{selectedPhoto.uploaderName}</p>
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

                <details className="rounded-md border p-3 text-sm">
                  <summary className="flex cursor-pointer items-center gap-2 font-medium"><History className="h-4 w-4" />History</summary>
                  {/* TODO(PR 4): Replace placeholder with photo_audit_log timeline. */}
                  <p className="mt-2 text-muted-foreground">Audit history will be available soon.</p>
                </details>

                <DialogFooter>
                  <Button variant="outline" onClick={() => void api(`/files/${selectedPhoto.id}/download`).then((data: any) => window.open(data.url, "_blank"))}>
                    <Download className="mr-1.5 h-4 w-4" />
                    Download
                  </Button>
                  <Button variant="destructive" onClick={() => setDeletePhoto(selectedPhoto)}>
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Delete
                  </Button>
                  <div className="ml-auto flex gap-1">
                    <Button variant="ghost" size="icon" disabled={selectedIndex <= 0} onClick={() => setSelectedId(flatPhotos[selectedIndex - 1]?.id)}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" disabled={selectedIndex >= flatPhotos.length - 1} onClick={() => setSelectedId(flatPhotos[selectedIndex + 1]?.id)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </DialogFooter>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={Boolean(deletePhoto)} onOpenChange={(open) => !open && setDeletePhoto(null)}>
        {deletePhoto && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this photo?</DialogTitle>
              <DialogDescription>It can be restored from the trash for 90 days.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeletePhoto(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => confirmDelete(deletePhoto)}>Delete photo</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
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

function PhotoTile({ photo, imageUrl, onOpen, onRestore }: { photo: DealPhotoRecord; imageUrl: string; onOpen: () => void; onRestore: () => void }) {
  const category = displayPhotoCategory(photo);
  return (
    <div className={`space-y-1 ${photo.deletedAt ? "opacity-55" : ""}`}>
      <button
        type="button"
        aria-label={`Open photo ${photo.displayName}`}
        className="group relative aspect-square w-full overflow-hidden rounded-lg border bg-muted text-left transition hover:ring-2 hover:ring-brand-red"
        onClick={onOpen}
      >
        {imageUrl ? <img src={imageUrl} alt={photo.displayName} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Camera className="h-7 w-7 text-muted-foreground" /></div>}
        <Avatar className="absolute bottom-2 left-2 h-7 w-7 border border-white shadow">
          <AvatarImage src={photo.uploaderAvatarUrl ?? undefined} />
          <AvatarFallback>{initials(photo.uploaderName)}</AvatarFallback>
        </Avatar>
        {category && <Badge className="absolute bottom-2 right-2 max-w-[70%] truncate text-[10px]">{category}</Badge>}
        {photo.deletedAt && <Badge variant="destructive" className="absolute left-2 top-2 text-[10px]">Deleted</Badge>}
      </button>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs text-muted-foreground">{formatTime(photo.takenAt ?? photo.createdAt)} • {photo.uploaderName}</p>
        {photo.deletedAt && (
          <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={onRestore}>
            <RotateCcw className="mr-1 h-3 w-3" />
            Restore
          </Button>
        )}
      </div>
    </div>
  );
}
