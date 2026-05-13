import React, { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PublicPhotoTokenPanel } from "@/components/photos/public-photo-token-panel";
import {
  buildPhotoFilterSearchParams,
  filtersFromSearchParams,
  groupDealPhotos,
  PhotoEmptyState,
  PhotoFilterBar,
  PhotoGridSkeleton,
  PhotoGridTile,
  PhotoGroupHeading,
  PhotoPaginationSummary,
  PhotoViewerModal,
  useDealPhotosData,
  type DealPhotoRecord,
  type PhotoFilterState,
} from "@/components/photos/deal-photo-components";

export {
  buildPhotoFilterSearchParams,
  groupDealPhotos,
  type DealPhotoRecord,
  type PhotoFilterState,
} from "@/components/photos/deal-photo-components";

export function DealPhotosTab({ dealId, onCountChange }: { dealId: string; onCountChange?: (count: number) => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => filtersFromSearchParams(searchParams));
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
  } = useDealPhotosData({ dealId, filters, onCountChange });

  React.useEffect(() => {
    setFilters(filtersFromSearchParams(searchParams));
  }, [searchParams]);

  const updateFilters = (next: PhotoFilterState) => {
    setFilters(next);
    const nextParams = new URLSearchParams(searchParams);
    ["category", "uploader", "from", "to", "group", "deleted"].forEach((key) => nextParams.delete(key));
    buildPhotoFilterSearchParams(next).forEach((value, key) => nextParams.set(key, value));
    setSearchParams(nextParams, { replace: true });
  };

  const uploaders = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatarUrl: string | null }>();
    photos.forEach((photo) => map.set(photo.uploadedBy, { id: photo.uploadedBy, name: photo.uploaderName, avatarUrl: photo.uploaderAvatarUrl }));
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [photos]);
  const groups = useMemo(() => groupDealPhotos(photos, filters), [photos, filters]);
  const flatPhotos = groups.flatMap((group) => group.photos);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Photos</h3>
          <p className="text-sm text-muted-foreground">Project photo history, location context, and field documentation.</p>
        </div>
        <div className="flex items-center gap-2">
          <PublicPhotoTokenPanel dealId={dealId} />
          <Button nativeButton={false} render={<Link to={`/photos/capture?dealId=${encodeURIComponent(dealId)}`} />} size="sm">
            <Upload className="mr-1.5 h-4 w-4" />
            Upload
          </Button>
        </div>
      </div>

      <PhotoFilterBar filters={filters} uploaders={uploaders} onChange={updateFilters} />

      {!loading && !error && (
        <PhotoPaginationSummary
          loadedCount={photos.length}
          totalCount={pagination.total}
          hasMore={hasMorePhotos}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onLoadMore={() => void loadMorePhotos()}
        />
      )}

      {loading && <PhotoGridSkeleton />}

      {!loading && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <Button className="ml-3" variant="outline" size="sm" onClick={fetchPhotos}>Retry</Button>
        </div>
      )}

      {!loading && !error && flatPhotos.length === 0 && (
        <PhotoEmptyState dealId={dealId} message="No photos have been added to this project yet" />
      )}

      {!loading && !error && groups.map((group) => (
        <section key={group.label} className="space-y-2">
          <PhotoGroupHeading label={group.label} count={group.photos.length} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            {group.photos.map((photo) => (
              <PhotoGridTile
                key={photo.id}
                photo={photo}
                imageUrl={getPhotoImageUrl(photo)}
                loadImageUrl={() => void ensurePhotoImageUrl(photo)}
                onOpen={() => setSelectedId(photo.id)}
                onRestore={() => restorePhoto(photo.id)}
              />
            ))}
          </div>
        </section>
      ))}

      {!loading && !error && hasMorePhotos && flatPhotos.length > 0 && (
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

      <PhotoViewerModal
        photos={flatPhotos}
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
