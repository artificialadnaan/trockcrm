import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Download, FileText, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api } from "@/lib/api";

// Mirrors the locked public payload (server: public-photo-tokens). The public surface
// exposes ONLY the photos and the property name/address — never the uploader, category,
// caption, timestamps, file metadata, or internal ids.
interface PublicPhoto {
  id: string;
  /** Grid-sized JPEG (`?variant=thumb`). */
  imageUrl: string | null;
  /** Full-resolution original, for the lightbox only. */
  fullImageUrl: string | null;
}

interface PublicViewerResponse {
  deal: {
    name: string;
    propertyAddress: string | null;
  };
  photos: PublicPhoto[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

// Column counts matching the Tailwind breakpoints below. Read at runtime (not from CSS) because the
// virtualizer needs to know how many photos share a row before it can compute row offsets.
const BREAKPOINT_COLUMNS: Array<{ minWidth: number; columns: number }> = [
  { minWidth: 1024, columns: 5 },
  { minWidth: 768, columns: 4 },
  { minWidth: 640, columns: 3 },
  { minWidth: 0, columns: 2 },
];

const GRID_GAP_PX = 12; // Tailwind gap-3
// Load the next page once the recipient is this many rows from the end, so scrolling stays continuous
// instead of stalling at each page boundary.
const PREFETCH_ROW_MARGIN = 3;

function columnsForWidth(width: number): number {
  return BREAKPOINT_COLUMNS.find((entry) => width >= entry.minWidth)?.columns ?? 2;
}

/**
 * One grid tile. `size` is supplied only in the virtualized layout, where absolute row positioning
 * means the tile can't take its dimensions from the CSS grid.
 */
function PhotoTile({
  photo,
  index,
  size,
  onOpen,
}: {
  photo: PublicPhoto;
  index: number;
  size?: number;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      // Indexed, leak-free name: keeps each thumbnail distinct for assistive tech and role/name
      // automation without exposing the photo's display name or any metadata.
      aria-label={`Shared photo ${index + 1}`}
      className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
      style={size ? { width: size, height: size } : undefined}
      onClick={() => onOpen(photo.id)}
    >
      <div className={`flex items-center justify-center bg-slate-200 ${size ? "h-full w-full" : "aspect-square"}`}>
        {photo.imageUrl ? (
          <img src={photo.imageUrl} alt={`Shared photo ${index + 1}`} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <FileText className="h-8 w-8 text-slate-400" />
        )}
      </div>
    </button>
  );
}

export function PublicPhotoViewerPage() {
  const { token } = useParams();
  const [deal, setDeal] = useState<PublicViewerResponse["deal"] | null>(null);
  const [photos, setPhotos] = useState<PublicPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Separate from `loading` (first paint) so a page-2+ fetch can show progress and, on failure, a retry
  // without ever swapping the loaded gallery for a spinner.
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  // Set once the server has served its last page. Authoritative over the `photos.length < total`
  // arithmetic, which can never close its gap after a mid-scroll upload or delete — see loadPage.
  const [endReached, setEndReached] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(() => columnsForWidth(typeof window === "undefined" ? 1280 : window.innerWidth));
  const [cellSize, setCellSize] = useState(220);
  // Virtualization needs real layout: a measured grid width to derive the column count and tile size.
  // Where that is unavailable (jsdom, SSR, engines without ResizeObserver) we fall back to a plain CSS
  // grid over the loaded pages — same markup, same behaviour, just unwindowed. Rendering nothing
  // because we could not measure would be a blank page on a customer-facing link, and the fallback is
  // bounded anyway because only fetched pages are in memory. Same "degrade to eager" principle as
  // client-field's LazyThumb.
  const [measured, setMeasured] = useState(false);
  // offsetTop measured into state rather than read during render: a layout read in the render path is
  // both a reflow and stale-by-one-frame, and offsetTop is relative to the nearest POSITIONED ancestor —
  // so if a wrapper ever gains `position: relative`, every virtual row would shift.
  const [gridOffsetTop, setGridOffsetTop] = useState(0);

  // Page currently being fetched (or already fetched). A ref, not state: the virtualizer's scroll
  // callback reads it every frame, and it must not be able to request the same page twice while a
  // request is in flight.
  const nextPageRef = useRef(1);
  const fetchingRef = useRef(false);
  // Which token the in-flight request belongs to. The route is `/p/:token` WITHOUT a key, so React
  // Router reuses this component across a param change and a request started for the previous token
  // would otherwise resolve into the new token's state — the old deal name, the old photos, and a
  // nextPage cursor counted against a different total. No in-app link navigates between two `/p/`
  // routes today (a share link is always opened as a fresh document), so this is hardening rather than
  // a live defect; it is here because the guard is what makes the invariant survive the next link.
  const requestTokenRef = useRef<string | undefined>(token);

  // The grid element only exists once there is something to render, so measurement has to wait for the
  // first page. Named rather than inlined so it can sit in a dep array without tripping exhaustive-deps.
  const hasPhotos = photos.length > 0;

  const loadPage = useCallback(
    async (pageNum: number) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      setPageError(false);
      setLoadingMore(true);
      // Captured BEFORE the await; every commit below is gated on it still being the live token.
      const requestToken = token;
      const isStale = () => requestTokenRef.current !== requestToken;
      try {
        const response = await api<PublicViewerResponse>(
          `/public/photo-viewer/${encodeURIComponent(token ?? "")}?page=${pageNum}`,
        );
        if (isStale()) return;
        setDeal(response.deal);
        setTotal(response.pagination?.total ?? response.photos.length);
        setPhotos((prev) => {
          if (pageNum === 1) return response.photos;
          // Dedupe on append. The server orders by timestamp with an id tiebreaker so pages don't
          // overlap, but a duplicate key here would crash the render — cheap insurance on a page a
          // customer sees.
          const seen = new Set(prev.map((photo) => photo.id));
          return [...prev, ...response.photos.filter((photo) => !seen.has(photo.id))];
        });
        nextPageRef.current = pageNum + 1;
        // THE SERVER decides when the gallery ends, not the arithmetic `photos.length < total`.
        //
        // Those two can disagree, and when they do the difference never closes: OFFSET paging over a
        // live deal shifts rows under the cursor, so a photo uploaded mid-scroll pushes one across a
        // page boundary and the dedupe above drops the repeat, while a deleted photo makes a page skip
        // one outright. Either way the gallery ends with `photos.length < total` after the last real
        // page. Left to `hasMore` alone the prefetch effect would then request page N+1 forever —
        // each empty response clears `loadingMore`, which re-fires the effect, which requests the next
        // page: an unbounded request loop from a customer's browser against an UNAUTHENTICATED
        // endpoint. Honouring totalPages (and an empty page, for a response with no pagination block)
        // makes the end a fact the server reports rather than a count the client infers.
        const totalPages = response.pagination?.totalPages;
        if (response.photos.length === 0 || totalPages === undefined || pageNum >= totalPages) {
          setEndReached(true);
        }
      } catch {
        // A failed FIRST page is fatal (the link itself is bad). A failed LATER page is recoverable and
        // must SAY so: nextPageRef is only advanced on success, so the retry re-requests the same page.
        // Without this the gallery sat on "Loading more photos…" forever — the auto-prefetch effect
        // cannot re-fire because none of its inputs change when a fetch fails, so one transient blip on
        // a 3000-photo share silently under-delivered it, which is the exact failure this change set
        // exists to remove.
        if (isStale()) return;
        if (pageNum === 1) setError("This photo link is no longer valid.");
        else setPageError(true);
      } finally {
        // Also gated: `fetchingRef` and the spinners now belong to the CURRENT token's request, so a
        // late loser clearing them would both hide a live spinner and unlock a second concurrent fetch.
        if (!isStale()) {
          fetchingRef.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [token],
  );

  useEffect(() => {
    // Publish the live token before the first fetch: anything still in flight for the previous one is
    // stale from this point on and will drop its result.
    requestTokenRef.current = token;
    setDeal(null);
    setPhotos([]);
    setTotal(0);
    setError(null);
    setLoading(true);
    nextPageRef.current = 1;
    fetchingRef.current = false;
    setPageError(false);
    setEndReached(false);
    void loadPage(1);
  }, [loadPage, token]);

  // Column COUNT comes from the viewport breakpoint (matching the Tailwind classes the fallback grid
  // uses); tile SIZE comes from the grid element's own width, which is padded and max-widthed. Both are
  // needed: the virtualizer positions rows absolutely, so it cannot inherit either from CSS.
  useLayoutEffect(() => {
    const node = gridRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = node.clientWidth;
      if (width <= 0) return; // no layout yet — stay in the unwindowed fallback
      const nextColumns = columnsForWidth(window.innerWidth);
      setColumns(nextColumns);
      setCellSize((width - GRID_GAP_PX * (nextColumns - 1)) / nextColumns);
      setGridOffsetTop(node.offsetTop);
      setMeasured(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasPhotos]);

  const rowCount = measured ? Math.ceil(photos.length / columns) : 0;
  const rowHeight = cellSize + GRID_GAP_PX; // square tiles (aspect-square)

  // Windowed rows. Without this, a 3000-photo share mounts 3000 <img> nodes at once: `loading="lazy"`
  // defers the BYTES but not the elements, and the layout/paint cost of the nodes alone is what made
  // big galleries crawl. Virtualizing means the DOM holds one screenful regardless of share size.
  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => rowHeight,
    overscan: 3,
    scrollMargin: gridOffsetTop,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastVisibleRow = virtualRows.length > 0 ? virtualRows[virtualRows.length - 1].index : 0;
  // `!endReached` is the load-bearing half — the count alone is what loops forever once the two
  // disagree (see loadPage). The count is kept as the second condition so the control still disappears
  // the instant a share is fully loaded, without waiting on a response to say so.
  const hasMore = !endReached && photos.length < total;

  useEffect(() => {
    if (!measured || !hasMore || loading || loadingMore || pageError) return;
    if (lastVisibleRow >= rowCount - PREFETCH_ROW_MARGIN) {
      void loadPage(nextPageRef.current);
    }
  }, [measured, hasMore, loading, loadingMore, pageError, lastVisibleRow, rowCount, loadPage]);

  const selectedIndex = useMemo(
    () => photos.findIndex((photo) => photo.id === selectedId),
    [photos, selectedId],
  );
  const selectedPhoto = selectedIndex >= 0 ? photos[selectedIndex] : null;

  async function downloadPhoto(photoId: string) {
    const response = await api<{ url: string }>(
      `/public/photo-viewer/${encodeURIComponent(token ?? "")}/photos/${encodeURIComponent(photoId)}/download`
    );
    window.open(response.url, "_blank", "noopener,noreferrer");
  }

  if (loading && photos.length === 0 && !error) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">Loading photos...</div>;
  }

  if (error || !deal) {
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
        <h1 className="mt-1 text-2xl font-semibold">{deal.name}</h1>
        {deal.propertyAddress && (
          <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
            <MapPin className="h-4 w-4" />
            {deal.propertyAddress}
          </p>
        )}
        {total > 0 && (
          <p className="mt-1 text-sm text-slate-500">
            {total} photo{total !== 1 ? "s" : ""}
          </p>
        )}
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {photos.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No photos have been shared yet.
          </div>
        ) : (
          <div ref={gridRef}>
            {measured ? (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualRows.map((virtualRow) => {
                  const start = virtualRow.index * columns;
                  return (
                    <div
                      key={virtualRow.key}
                      className="absolute left-0 top-0 flex w-full"
                      style={{
                        height: rowHeight,
                        gap: GRID_GAP_PX,
                        transform: `translateY(${virtualRow.start - gridOffsetTop}px)`,
                      }}
                    >
                      {photos.slice(start, start + columns).map((photo, columnIndex) => (
                        <PhotoTile
                          key={photo.id}
                          photo={photo}
                          index={start + columnIndex}
                          size={cellSize}
                          onOpen={setSelectedId}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {photos.map((photo, index) => (
                  <PhotoTile key={photo.id} photo={photo} index={index} onOpen={setSelectedId} />
                ))}
              </div>
            )}
            {hasMore && (
              <div className="flex flex-col items-center gap-2 py-6 text-sm text-slate-500">
                {pageError && <p>Couldn't load the rest of these photos.</p>}
                {/* A button whenever the gallery isn't actively fetching — that covers the retry AND the
                    unwindowed fallback, where there is no scroll-driven prefetch to rely on. */}
                {loadingMore ? (
                  <p>
                    Loading more photos... ({photos.length} of {total})
                  </p>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void loadPage(nextPageRef.current)}>
                    {pageError ? "Try again" : `Load more photos (${photos.length} of ${total})`}
                  </Button>
                )}
              </div>
            )}
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
                <img
                  // Full resolution HERE only. The grid deliberately serves a ~40KB thumbnail; a
                  // recipient who opens one photo should still get the real thing.
                  src={selectedPhoto.fullImageUrl ?? selectedPhoto.imageUrl}
                  alt={`Shared photo ${selectedIndex + 1}`}
                  className="max-h-[90vh] max-w-full object-contain"
                />
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
