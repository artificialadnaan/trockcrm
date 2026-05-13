import React, { useEffect, useMemo, useState } from "react";
import { Download, RotateCcw, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildPhotoFilterSearchParams,
  displayPhotoCategory,
  filtersFromSearchParams,
  formatPhotoTime,
  initials,
  matchesPhotoFilters,
  PhotoEmptyState,
  PhotoFilterBar,
  PhotoPaginationSummary,
  PhotoViewerModal,
  useInViewport,
  type DealPhotoRecord,
  type PhotoFilterState,
} from "@/components/photos/deal-photo-components";
import { useDealPhotosData } from "@/components/photos/deal-photo-components";
import { formatFileSize } from "@/lib/file-utils";

export type PhotoFileSortKey = "uploaded_at" | "taken_at" | "uploader" | "file_size" | "category";
type SortDirection = "asc" | "desc";

function sortValue(photo: DealPhotoRecord, sortKey: PhotoFileSortKey): number | string {
  if (sortKey === "uploaded_at") return new Date(photo.createdAt).getTime();
  if (sortKey === "taken_at") return new Date(photo.takenAt ?? photo.createdAt).getTime();
  if (sortKey === "uploader") return photo.uploaderName.toLowerCase();
  if (sortKey === "file_size") return photo.fileSizeBytes ?? 0;
  return (displayPhotoCategory(photo) ?? "Uncategorized").toLowerCase();
}

export function sortDealPhotosForFiles(photos: DealPhotoRecord[], sortKey: PhotoFileSortKey, sortDir: SortDirection) {
  return [...photos].sort((left, right) => {
    const a = sortValue(left, sortKey);
    const b = sortValue(right, sortKey);
    const direction = sortDir === "asc" ? 1 : -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
    return String(a).localeCompare(String(b)) * direction;
  });
}

function hasActivePhotoFilters(filters: PhotoFilterState) {
  return filters.categories.length > 0 || filters.uploaderIds.length > 0 || Boolean(filters.from || filters.to || filters.showDeleted);
}

function buildFilesPhotoFilters(params: URLSearchParams): PhotoFilterState {
  return { ...filtersFromSearchParams(params), group: "none" as const };
}

export function DealFilePhotosSubview({ dealId }: { dealId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => buildFilesPhotoFilters(searchParams));
  const [sortKey, setSortKey] = useState<PhotoFileSortKey>("uploaded_at");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const {
    photos,
    loading,
    loadingMore,
    error,
    loadMoreError,
    pagination,
    hasMorePhotos,
    fetchPhotos,
    loadMorePhotos,
    getPhotoImageUrl,
    ensurePhotoImageUrl,
    patchPhoto,
    savePhotoAddress,
    deletePhoto,
    restorePhoto,
    downloadPhoto,
  } = useDealPhotosData({ dealId, filters });

  React.useEffect(() => {
    setFilters(buildFilesPhotoFilters(searchParams));
  }, [searchParams]);

  const updateFilters = (next: PhotoFilterState) => {
    const normalized: PhotoFilterState = { ...next, group: "none" };
    setFilters(normalized);
    const nextParams = new URLSearchParams(searchParams);
    ["category", "uploader", "from", "to", "group", "deleted"].forEach((key) => nextParams.delete(key));
    buildPhotoFilterSearchParams(normalized, { includeGroup: false }).forEach((value, key) => nextParams.set(key, value));
    setSearchParams(nextParams, { replace: true });
  };

  const uploaders = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatarUrl: string | null }>();
    photos.forEach((photo) => map.set(photo.uploadedBy, { id: photo.uploadedBy, name: photo.uploaderName, avatarUrl: photo.uploaderAvatarUrl }));
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [photos]);
  const visiblePhotos = useMemo(() => photos.filter((photo) => matchesPhotoFilters(photo, filters)), [filters, photos]);
  const sortedPhotos = useMemo(() => sortDealPhotosForFiles(visiblePhotos, sortKey, sortDir), [sortDir, sortKey, visiblePhotos]);

  const toggleSort = (nextKey: PhotoFileSortKey) => {
    if (nextKey === sortKey) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDir(nextKey === "uploader" || nextKey === "category" ? "asc" : "desc");
  };

  const sortLabel = (key: PhotoFileSortKey, label: string) => `${label}${sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}`;

  return (
    <div className="space-y-3">
      <PhotoFilterBar filters={filters} uploaders={uploaders} onChange={updateFilters} showGrouping={false} />

      {!loading && !error && (
        <PhotoPaginationSummary
          loadedCount={photos.length}
          totalCount={pagination.total}
          hasMore={hasMorePhotos}
          loadingMore={loadingMore}
          loadMoreError={null}
          showLoadMore={false}
          onLoadMore={() => void loadMorePhotos()}
        />
      )}

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-16 animate-pulse rounded bg-muted" />)}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <Button className="ml-3" variant="outline" size="sm" onClick={fetchPhotos}>Retry</Button>
        </div>
      )}

      {!loading && !error && sortedPhotos.length === 0 && (
        <PhotoEmptyState dealId={dealId} message={hasActivePhotoFilters(filters) ? "No photos match these filters." : "No photos uploaded to this deal yet."} />
      )}

      {!loading && !error && sortedPhotos.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <div className="hidden grid-cols-[64px_minmax(180px,1.4fr)_120px_minmax(150px,1fr)_minmax(180px,1fr)_135px_135px_90px_92px] gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground lg:grid">
            <span>Photo</span>
            <button type="button" className="text-left" onClick={() => toggleSort("uploaded_at")}>Filename / caption</button>
            <button type="button" className="text-left" onClick={() => toggleSort("category")}>{sortLabel("category", "Category")}</button>
            <button type="button" className="text-left" onClick={() => toggleSort("uploader")}>{sortLabel("uploader", "Uploader")}</button>
            <span>Address</span>
            <button type="button" className="text-left" onClick={() => toggleSort("taken_at")}>{sortLabel("taken_at", "Taken")}</button>
            <button type="button" className="text-left" onClick={() => toggleSort("uploaded_at")}>{sortLabel("uploaded_at", "Uploaded")}</button>
            <button type="button" className="text-left" onClick={() => toggleSort("file_size")}>{sortLabel("file_size", "Size")}</button>
            <span>Actions</span>
          </div>
          <div className="divide-y">
            {sortedPhotos.map((photo) => (
              <PhotoFileRow
                key={photo.id}
                photo={photo}
                imageUrl={getPhotoImageUrl(photo)}
                loadImageUrl={() => void ensurePhotoImageUrl(photo)}
                onOpen={() => setSelectedId(photo.id)}
                onDownload={() => downloadPhoto(photo.id)}
                onDelete={() => deletePhoto(photo.id)}
                onRestore={() => restorePhoto(photo.id)}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && !error && hasMorePhotos && sortedPhotos.length > 0 && (
        <PhotoPaginationSummary
          loadedCount={photos.length}
          totalCount={pagination.total}
          hasMore={hasMorePhotos}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onLoadMore={() => void loadMorePhotos()}
        />
      )}

      <PhotoViewerModal
        photos={sortedPhotos}
        selectedId={selectedId}
        onSelectedIdChange={setSelectedId}
        getPhotoImageUrl={getPhotoImageUrl}
        ensurePhotoImageUrl={ensurePhotoImageUrl}
        patchPhoto={patchPhoto}
        savePhotoAddress={savePhotoAddress}
        deletePhoto={deletePhoto}
        downloadPhoto={downloadPhoto}
      />
    </div>
  );
}

function PhotoFileRow({
  photo,
  imageUrl,
  loadImageUrl,
  onOpen,
  onDownload,
  onDelete,
  onRestore,
}: {
  photo: DealPhotoRecord;
  imageUrl: string;
  loadImageUrl: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const [rowRef, inViewport] = useInViewport<HTMLDivElement>();
  const category = displayPhotoCategory(photo);
  const primaryLabel = photo.description || `${photo.displayName}${photo.fileExtension ?? ""}`;
  const uploadedAt = new Date(photo.createdAt).toLocaleDateString();
  const takenAt = photo.takenAt ? new Date(photo.takenAt).toLocaleDateString() : "Same as uploaded";

  useEffect(() => {
    if (inViewport && !imageUrl) loadImageUrl();
  }, [imageUrl, inViewport, loadImageUrl]);

  return (
    <div ref={rowRef} className={`grid gap-3 px-3 py-3 transition hover:bg-accent/50 lg:grid-cols-[64px_minmax(180px,1.4fr)_120px_minmax(150px,1fr)_minmax(180px,1fr)_135px_135px_90px_92px] lg:items-center ${photo.deletedAt ? "opacity-55" : ""}`}>
      <button type="button" aria-label={`Open photo ${photo.displayName}`} className="h-12 w-12 overflow-hidden rounded border bg-muted" onClick={onOpen}>
        {imageUrl ? <img src={imageUrl} alt={photo.displayName} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">Photo</div>}
      </button>

      <button type="button" className="min-w-0 text-left" onClick={onOpen}>
        <p className="truncate text-sm font-medium">{primaryLabel}</p>
        <p className="truncate text-xs text-muted-foreground">{photo.displayName}{photo.fileExtension ?? ""}</p>
      </button>

      <div>
        <Badge variant={category ? "secondary" : "outline"}>{category ?? "Uncategorized"}</Badge>
        {photo.deletedAt && <Badge variant="destructive" className="ml-1">Deleted</Badge>}
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <Avatar className="h-7 w-7"><AvatarImage src={photo.uploaderAvatarUrl ?? undefined} /><AvatarFallback>{initials(photo.uploaderName)}</AvatarFallback></Avatar>
        <span className="truncate text-sm">{photo.uploaderName}</span>
      </div>

      <p className="truncate text-sm text-muted-foreground" title={photo.address ?? undefined}>{photo.address ?? "No address saved"}</p>
      <p className="text-sm text-muted-foreground">{takenAt}</p>
      <p className="text-sm text-muted-foreground">{uploadedAt}</p>
      <p className="text-sm text-muted-foreground">{formatFileSize(photo.fileSizeBytes ?? 0)}</p>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Download" onClick={onDownload}>
          <Download className="h-4 w-4" />
        </Button>
        {photo.deletedAt ? (
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Restore" onClick={onRestore}>
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600" title="Delete" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground lg:hidden">
        <span>{category ?? "Uncategorized"}</span>
        <span>{photo.uploaderName}</span>
        <span>{formatPhotoTime(photo.takenAt ?? photo.createdAt)}</span>
        <span>{formatFileSize(photo.fileSizeBytes ?? 0)}</span>
      </div>
    </div>
  );
}
