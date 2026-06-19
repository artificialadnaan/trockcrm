import React, { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PublicPhotoTokenPanel } from "@/components/photos/public-photo-token-panel";
import {
  buildPhotoFilterSearchParams,
  filtersFromSearchParams,
  getPhotoTags,
  groupDealPhotos,
  legacyCategoryOptionsInUse,
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
import { useFiles, useTagSuggestions } from "@/hooks/use-files";

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
  const { files: reportFiles, loading: reportsLoading } = useFiles({
    dealId,
    category: "other",
    tags: ["photo-report"],
    sortBy: "created_at",
    sortDir: "desc",
    limit: 20,
  });
  const { tags: suggestedTags } = useTagSuggestions(dealId);
  const availableSuggestedTags = Array.isArray(suggestedTags) ? suggestedTags : [];

  React.useEffect(() => {
    setFilters(filtersFromSearchParams(searchParams));
  }, [searchParams]);

  const updateFilters = (next: PhotoFilterState) => {
    setFilters(next);
    const nextParams = new URLSearchParams(searchParams);
    ["category", "tags", "uploader", "from", "to", "group", "deleted"].forEach((key) => nextParams.delete(key));
    buildPhotoFilterSearchParams(next).forEach((value, key) => nextParams.set(key, value));
    setSearchParams(nextParams, { replace: true });
  };

  const availableTags = useMemo(() => {
    const map = new Map<string, string>();
    availableSuggestedTags.forEach((tag) => {
      const normalized = tag.trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (!map.has(key)) map.set(key, normalized);
    });
    photos.forEach((photo) => {
      for (const tag of getPhotoTags(photo.tags)) {
        const normalized = tag.trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (!map.has(key)) map.set(key, normalized);
      }
    });
    return Array.from(map.values()).sort((left, right) => left.localeCompare(right));
  }, [availableSuggestedTags, photos]);
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

      <section className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold">Generated Reports</h4>
            <p className="text-xs text-muted-foreground">Branded photo PDFs generated from the field app.</p>
          </div>
        </div>
        {reportsLoading ? (
          <p className="text-sm text-muted-foreground">Loading reports...</p>
        ) : reportFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No generated reports yet.</p>
        ) : (
          <div className="space-y-2">
            {reportFiles.map((report) => (
              <button
                key={report.id}
                type="button"
                className="flex w-full items-center justify-between rounded-md border px-3 py-3 text-left hover:bg-muted/30"
                onClick={() => void downloadPhoto(report.id)}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{report.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">{new Date(report.createdAt).toLocaleString()}</p>
                </div>
                <Upload className="h-4 w-4 rotate-180 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </section>

      <PhotoFilterBar filters={filters} availableTags={availableTags} uploaders={uploaders} onChange={updateFilters} legacyCategoryOptions={legacyCategoryOptionsInUse(photos, !hasMorePhotos)} />

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
