import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Camera,
  Image as ImageIcon,
  Search,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  FileIcon,
  FileText,
  Video,
  Link2,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDealDisplayNumber } from "@/lib/deal-utils";
import { api } from "@/lib/api";
import { usePhotoFeed, type FeedFilters, type FeedPhoto } from "@/hooks/use-photo-feed";
import { PhotoLightbox } from "@/components/photos/photo-lightbox";
import { getFileMediaKind, type FileMediaKind } from "@/lib/file-media";
import {
  getImmediatePhotoOpenUrl,
  getImmediatePhotoPreviewUrl,
  shouldFetchSignedPhotoUrl,
} from "@/lib/photo-url-resolution";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProjectRecentPhoto {
  id: string;
  displayName: string | null;
  mimeType: string | null;
  r2Key: string | null;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
}

interface ProjectStat {
  dealId: string;
  dealName: string;
  dealNumber: string;
  propertyCity: string | null;
  propertyState: string | null;
  photoCount: number;
  lastPhotoAt: string | null;
  recentUploaders: string[];
  recentPhotoIds: string[];
  recentPhotos?: ProjectRecentPhoto[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function formatDateHeader(dateStr: string): string {
  const d = new Date(dateStr);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const month = d.toLocaleDateString("en-US", { month: "long" });
  const day = d.getDate();
  const year = d.getFullYear();
  return `${weekday}, ${month} ${day}${getOrdinalSuffix(day)}, ${year}`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getDateKey(date: string): string {
  return new Date(date).toISOString().split("T")[0];
}

function getInitials(name: string | null): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hashStringToColor(str: string): string {
  const colors = [
    "#E53E3E", "#DD6B20", "#D69E2E", "#38A169", "#319795",
    "#3182CE", "#5A67D8", "#805AD5", "#D53F8C", "#2B6CB0",
    "#C05621", "#2F855A", "#6B46C1", "#B83280", "#276749",
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}

// ─── Thumbnail Cache ────────────────────────────────────────────────────────

const THUMB_CACHE_MAX = 200;
const thumbCache = new Map<string, string>();
const thumbRequests = new Map<string, Promise<string>>();

function setThumbCache(key: string, value: string) {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    // Delete oldest entry (first key in insertion order)
    const firstKey = thumbCache.keys().next().value;
    if (firstKey) thumbCache.delete(firstKey);
  }
  thumbCache.set(key, value);
}

async function fetchCachedDownloadUrl(
  fileId: string,
  cacheKey: string = fileId,
  options: { preview?: boolean } = { preview: true }
): Promise<string> {
  const cachedUrl = thumbCache.get(cacheKey);
  if (cachedUrl) return cachedUrl;

  const pendingRequest = thumbRequests.get(cacheKey);
  if (pendingRequest) return pendingRequest;

  const previewQuery = options.preview === false ? "" : "?preview=1";
  const request = api<{ url: string }>(`/files/${fileId}/download${previewQuery}`)
    .then((data) => {
      setThumbCache(cacheKey, data.url);
      return data.url;
    })
    .finally(() => {
      thumbRequests.delete(cacheKey);
    });

  thumbRequests.set(cacheKey, request);
  return request;
}

function useInViewport<T extends HTMLElement>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [inViewport, setInViewport] = useState(false);

  useEffect(() => {
    if (!node || inViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [inViewport, node]);

  return [setNode, inViewport];
}

function fileIconForKind(kind: FileMediaKind) {
  if (kind === "image") return ImageIcon;
  if (kind === "pdf" || kind === "document") return FileText;
  if (kind === "video") return Video;
  return FileIcon;
}

function openFileUrl(url: string | null) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openFeedFile(photo: ThumbnailSource) {
  const cachedUrl = thumbCache.get(`open:${photo.id}`) ?? thumbCache.get(photo.id) ?? null;
  const immediateUrl = getImmediatePhotoOpenUrl(photo, cachedUrl);
  if (immediateUrl) {
    openFileUrl(immediateUrl);
    return;
  }

  try {
    const url = await fetchCachedDownloadUrl(photo.id, `open:${photo.id}`, { preview: false });
    openFileUrl(url);
  } catch (err) {
    console.error("Failed to open file:", err);
  }
}

interface ThumbnailSource {
  id: string;
  externalThumbnailUrl: string | null;
  externalUrl: string | null;
  mimeType: string | null;
  displayName: string | null;
  r2Key: string | null;
}

function useThumbnailUrl(photo: ThumbnailSource, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    return getImmediatePhotoPreviewUrl(photo, thumbCache.get(photo.id) ?? null);
  });

  useEffect(() => {
    const cachedSignedUrl = thumbCache.get(photo.id) ?? null;
    const immediateUrl = getImmediatePhotoPreviewUrl(photo, cachedSignedUrl);
    if (immediateUrl) {
      setUrl(immediateUrl);
      return;
    }
    if (!enabled) return;
    if (!shouldFetchSignedPhotoUrl(photo, cachedSignedUrl)) return;
    let cancelled = false;

    fetchCachedDownloadUrl(photo.id)
      .then((signedUrl) => {
        if (!cancelled) setUrl(signedUrl);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [enabled, photo.id, photo.r2Key, photo.externalThumbnailUrl, photo.externalUrl, url]);

  return url;
}

// ─── Initials Circle ────────────────────────────────────────────────────────

function InitialsCircle({
  name,
  size = "sm",
}: {
  name: string | null;
  size?: "sm" | "md";
}) {
  const initials = getInitials(name);
  const color = hashStringToColor(name ?? "Unknown");
  const sizeClasses = size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs";

  return (
    <div
      className={`${sizeClasses} rounded-full flex items-center justify-center text-white font-bold shrink-0`}
      style={{ backgroundColor: color }}
      title={name ?? "Unknown"}
    >
      {initials}
    </div>
  );
}

// ─── Project Row Component ──────────────────────────────────────────────────

function ProjectRow({
  project,
  onClick,
}: {
  project: ProjectStat;
  onClick: () => void;
}) {
  const recentPhotos =
    project.recentPhotos?.length
      ? project.recentPhotos.slice(0, 5)
      : project.recentPhotoIds.slice(0, 5).map((id) => ({
          id,
          displayName: `Photo ${id.slice(0, 8)}`,
          // Project stats only supplies recentPhotoIds for category='photo'
          // records, so degraded payloads can still fetch image thumbnails.
          mimeType: "image/jpeg",
          r2Key: null,
          externalUrl: null,
          externalThumbnailUrl: null,
        }));
  const featurePhoto = recentPhotos[0];

  const location = [project.propertyCity, project.propertyState]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className="flex items-center gap-4 p-4 bg-white rounded-lg border border-gray-200 hover:border-[#CC0000]/30 hover:shadow-sm transition-all cursor-pointer"
      onClick={onClick}
    >
      {/* Left: feature image + project info */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Feature thumbnail */}
        <div className="h-16 w-16 rounded-lg overflow-hidden bg-gray-100 shrink-0">
          {featurePhoto ? (
            <ProjectRecentMediaThumb photo={featurePhoto} alt={project.dealName} size="feature" />
          ) : (
            <div className="h-full w-full flex items-center justify-center">
              <ImageIcon className="h-6 w-6 text-gray-300" />
            </div>
          )}
        </div>

        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate text-sm">
            {project.dealName}
          </p>
          {location && (
            <p className="text-xs text-gray-500 truncate">{location}</p>
          )}
          {project.lastPhotoAt && (
            <p className="text-xs text-gray-400 mt-0.5">
              Last updated {timeAgo(project.lastPhotoAt)}
            </p>
          )}
          <span className="inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#CC0000]/10 text-[#CC0000]">
            CRM Deal
          </span>
        </div>
      </div>

      {/* Middle: photo count + recent users */}
      <div className="hidden md:flex flex-col items-center gap-1 shrink-0 px-4 min-w-[100px]">
        <div className="text-center">
          <p className="text-xs text-gray-500 font-medium">Photos</p>
          <p className="text-2xl font-bold text-gray-900">{project.photoCount}</p>
        </div>
        {project.recentUploaders.length > 0 && (
          <div>
            <p className="text-[10px] text-gray-400 text-center mb-1">Recent Users</p>
            <div className="flex -space-x-1">
              {project.recentUploaders.slice(0, 4).map((name, i) => (
                <InitialsCircle key={i} name={name} size="sm" />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right: recent photo thumbnails */}
      <div className="hidden lg:flex items-center gap-1 shrink-0">
        {project.photoCount === 0 ? (
          <p className="text-xs text-gray-400 italic max-w-[300px]">
            No photos have been added to this project yet.
          </p>
        ) : (
          recentPhotos.map((photo) => (
            <div
              key={photo.id}
              className="h-[72px] w-[72px] rounded-md overflow-hidden bg-gray-100 shrink-0"
            >
              <ProjectRecentMediaThumb photo={photo} alt="" size="strip" />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ProjectRecentMediaThumb({
  photo,
  alt,
  size,
}: {
  photo: ProjectRecentPhoto;
  alt: string;
  size: "feature" | "strip";
}) {
  const [containerRef, inViewport] = useInViewport<HTMLDivElement>();
  const kind = getFileMediaKind(photo);
  const thumbUrl = useThumbnailUrl(photo, kind === "image" && inViewport);
  const Icon = fileIconForKind(kind);
  const iconClassName = size === "feature" ? "h-6 w-6" : "h-4 w-4";

  return (
    <div ref={containerRef} className="h-full w-full">
      {kind === "image" && thumbUrl ? (
        <img src={thumbUrl} alt={alt} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="h-full w-full flex items-center justify-center bg-slate-100">
          <Icon className={`${iconClassName} text-slate-400`} />
        </div>
      )}
    </div>
  );
}

// ─── Photo Grid Card ────────────────────────────────────────────────────────

function PhotoGridCard({
  photo,
  onClick,
}: {
  photo: FeedPhoto;
  onClick: () => void;
}) {
  const mediaKind = getFileMediaKind(photo);
  const thumbUrl = useThumbnailUrl(photo, mediaKind === "image");
  const timeStr = formatTime(photo.takenAt || photo.createdAt);
  const Icon = fileIconForKind(mediaKind);
  const isImage = mediaKind === "image";

  return (
    <div
      className="cursor-pointer group"
      onClick={() => {
        if (isImage) onClick();
        else void openFeedFile(photo);
      }}
    >
      {/* Thumbnail */}
      <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-gray-100">
        {!isImage ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-slate-100 p-3 text-center">
            <Icon className="h-8 w-8 text-slate-500" />
            <span className="line-clamp-2 text-[11px] font-semibold text-slate-600">
              {mediaKind === "pdf" ? "PDF" : "File"}
            </span>
          </div>
        ) : thumbUrl ? (
          <img
            src={thumbUrl}
            alt={photo.dealName || photo.displayName}
            loading="lazy"
            className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="h-8 w-8 text-gray-300" />
          </div>
        )}
        {/* User initials overlay */}
        <div className="absolute bottom-1.5 left-1.5">
          <InitialsCircle name={photo.uploaderName} size="sm" />
        </div>
      </div>

      {/* Caption */}
      <div className="mt-1.5 px-0.5">
        <p className="text-xs font-medium text-gray-900 truncate">
          {truncate(photo.dealName || "Unassigned", 22)}
        </p>
        <p className="text-[11px] text-gray-500 truncate">
          {timeStr} &bull; {truncate(photo.uploaderName || "Unknown", 16)}
        </p>
      </div>
    </div>
  );
}

// ─── Date-Grouped Photos ────────────────────────────────────────────────────

interface DateGroup {
  dateKey: string;
  dateLabel: string;
  photos: { photo: FeedPhoto; globalIndex: number }[];
}

function groupPhotosByDate(photos: FeedPhoto[]): DateGroup[] {
  const map = new Map<string, DateGroup>();

  photos.forEach((photo, index) => {
    const dateKey = getDateKey(photo.takenAt || photo.createdAt);

    if (!map.has(dateKey)) {
      map.set(dateKey, {
        dateKey,
        dateLabel: formatDateHeader(photo.takenAt || photo.createdAt),
        photos: [],
      });
    }
    map.get(dateKey)!.photos.push({ photo, globalIndex: index });
  });

  return Array.from(map.values()).sort((a, b) =>
    b.dateKey.localeCompare(a.dateKey)
  );
}

// ─── Unassigned CompanyCam Tab ──────────────────────────────────────────────

interface CompanyCamProjectStat {
  companycamProjectId: string;
  companycamProjectName: string | null;
  photoCount: number;
  lastPhotoAt: string | null;
  recentPhotos: ProjectRecentPhoto[];
}

interface DealSearchOption {
  id: string;
  name: string;
  dealNumber: string;
  projectNumber?: string | null;
}

// "Assign to deal" control for an unassigned CompanyCam project: a popover with a searchable deal picker.
// Picking a deal moves ALL of the project's unassigned photos onto it (server enforces the exact set).
// Universal — any CRM user. `onAssigned` is called so the caller can drop the project from the list.
function AssignToDealPopover({
  companycamProjectId,
  photoCount,
  onAssigned,
}: {
  companycamProjectId: string;
  photoCount: number;
  onAssigned: (assignedCount: number, deal: DealSearchOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [deals, setDeals] = useState<DealSearchOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearching(true);
    setSearchFailed(false);
    const handle = setTimeout(() => {
      const q = query.trim();
      const qs = q ? `&search=${encodeURIComponent(q)}` : "";
      // scope=all so ANY user can find ANY active deal — the deals route otherwise defaults to the caller's
      // "mine" view, which would hide other people's deals even though the assign endpoint accepts any of
      // them (the feature is universal). scope=all elevates the read office-wide (CodeRabbit/Codex).
      api<{ deals: DealSearchOption[] }>(`/deals?scope=all&isActive=true&limit=20${qs}`)
        // Keep a failed lookup DISTINCT from an empty result so the picker can offer a retry instead of
        // misreporting "No deals found" when the request itself errored (CodeRabbit).
        .then((d) => { if (!cancelled) { setDeals(d.deals ?? []); setSearchFailed(false); } })
        .catch(() => { if (!cancelled) { setDeals([]); setSearchFailed(true); } })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, open, reloadKey]);

  async function assign(deal: DealSearchOption) {
    setAssigningId(deal.id);
    try {
      const res = await api<{ assignedCount: number }>(
        `/files/photos/unassigned-companycam/${encodeURIComponent(companycamProjectId)}/assign`,
        { method: "POST", json: { dealId: deal.id } },
      );
      if (res.assignedCount > 0) {
        toast.success(
          `Assigned ${res.assignedCount} photo${res.assignedCount !== 1 ? "s" : ""} to ${formatDealDisplayNumber(deal).label}`,
        );
      } else {
        // The race-safe server path can claim 0 rows (e.g. the project was already assigned elsewhere) and
        // does NOT persist the deal link — don't imply a successful assignment.
        toast.info("No photos were assigned — they may have already been assigned to a deal.");
      }
      setOpen(false);
      onAssigned(res.assignedCount, deal);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to assign photos");
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
            <Link2 className="h-3.5 w-3.5" />
            Assign to deal
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-80 p-0"
        // Focus the search input WITHOUT scrolling. A native `autoFocus` (and Base UI's own
        // initialFocus when it targets a child) calls focus() with preventScroll:false on a
        // freshly-portaled, not-yet-positioned popup — which jumps the whole page to the top. Focus
        // the input ourselves with preventScroll:true and return false so Base UI doesn't re-focus.
        initialFocus={() => {
          searchInputRef.current?.focus({ preventScroll: true });
          return false;
        }}
      >
        <div className="border-b p-2">
          <p className="px-1 pb-2 text-xs text-gray-500">
            Assign {photoCount} photo{photoCount !== 1 ? "s" : ""} to:
          </p>
          <Input
            ref={searchInputRef}
            placeholder="Search deals by name or number..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {searching ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            </div>
          ) : searchFailed ? (
            <div className="px-3 py-4 text-center">
              <p className="text-xs text-gray-500">Couldn&apos;t load deals.</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-7 text-xs"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                <RefreshCw className="mr-1 h-3 w-3" /> Retry
              </Button>
            </div>
          ) : deals.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-gray-500">No deals found</p>
          ) : (
            deals.map((d) => (
              <button
                key={d.id}
                type="button"
                disabled={assigningId !== null}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50"
                onClick={() => assign(d)}
              >
                {assigningId === d.id ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" />
                ) : (
                  <Check className="h-3.5 w-3.5 shrink-0 text-transparent" />
                )}
                <span className="font-mono text-xs text-gray-500">{formatDealDisplayNumber(d).label}</span>
                <span className="truncate text-gray-900">{d.name}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CompanyCamProjectRow({
  project,
  onClick,
  onAssigned,
}: {
  project: CompanyCamProjectStat;
  onClick: () => void;
  onAssigned: (assignedCount: number, deal: DealSearchOption) => void;
}) {
  const recentPhotos = project.recentPhotos?.slice(0, 5) ?? [];
  const featurePhoto = recentPhotos[0];
  const name = project.companycamProjectName || `CompanyCam project ${project.companycamProjectId}`;

  return (
    <div className="w-full flex items-center gap-4 p-4 bg-white rounded-lg border border-gray-200 hover:border-[#CC0000]/30 hover:shadow-sm transition-all">
      {/* Clicking the body drills into the project's photos; the Assign control sits outside this button. */}
      <button
        type="button"
        className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer"
        onClick={onClick}
      >
        <div className="h-16 w-16 rounded-lg overflow-hidden bg-gray-100 shrink-0">
          {featurePhoto ? (
            <ProjectRecentMediaThumb photo={featurePhoto} alt={name} size="feature" />
          ) : (
            <div className="h-full w-full flex items-center justify-center">
              <ImageIcon className="h-6 w-6 text-gray-300" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate text-sm">{name}</p>
          <p className="text-xs text-gray-400 font-mono truncate">cc#{project.companycamProjectId}</p>
          {project.lastPhotoAt && (
            <p className="text-xs text-gray-400 mt-0.5">Last photo {timeAgo(project.lastPhotoAt)}</p>
          )}
          <span className="inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
            CompanyCam · Unassigned
          </span>
        </div>
      </button>

      <div className="hidden md:flex flex-col items-center gap-1 shrink-0 px-4 min-w-[100px]">
        <p className="text-xs text-gray-500 font-medium">Photos</p>
        <p className="text-2xl font-bold text-gray-900">{project.photoCount}</p>
      </div>

      <div className="hidden xl:flex items-center gap-1 shrink-0">
        {recentPhotos.map((photo) => (
          <div key={photo.id} className="h-[72px] w-[72px] rounded-md overflow-hidden bg-gray-100 shrink-0">
            <ProjectRecentMediaThumb photo={photo} alt="" size="strip" />
          </div>
        ))}
      </div>

      <AssignToDealPopover
        companycamProjectId={project.companycamProjectId}
        photoCount={project.photoCount}
        onAssigned={onAssigned}
      />
    </div>
  );
}

// Drill-in: paginated photos for a single unassigned CompanyCam project.
function UnassignedProjectPhotos({
  project,
  onBack,
  onAssigned,
}: {
  project: CompanyCamProjectStat;
  onBack: () => void;
  onAssigned: () => void;
}) {
  const [photos, setPhotos] = useState<FeedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ photos: FeedPhoto[]; pagination: { totalPages: number; total: number } }>(
      `/files/photos/unassigned-companycam/${encodeURIComponent(project.companycamProjectId)}?page=${page}&limit=60`,
    )
      .then((d) => {
        if (cancelled) return;
        setPhotos(d.photos);
        setTotalPages(d.pagination.totalPages);
        setTotal(d.pagination.total);
      })
      .catch((err) => console.error("Failed to load unassigned CompanyCam photos:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project.companycamProjectId, page]);

  const name = project.companycamProjectName || `CompanyCam project ${project.companycamProjectId}`;

  return (
    <div className="px-6 py-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-4"
      >
        <ChevronLeft className="h-4 w-4" /> Back to unassigned projects
      </button>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 truncate">{name}</h2>
          <p className="text-xs text-gray-500">
            cc#{project.companycamProjectId} &bull; {total} photo{total !== 1 ? "s" : ""}
          </p>
        </div>
        <AssignToDealPopover
          companycamProjectId={project.companycamProjectId}
          photoCount={total || project.photoCount}
          onAssigned={onAssigned}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {photos.map((photo, i) => (
              <div
                key={photo.id}
                className="w-[calc(50%-4px)] sm:w-[calc(25%-6px)] md:w-[calc(20%-6.4px)] lg:w-[calc(16.666%-6.7px)] xl:w-[150px]"
              >
                <PhotoGridCard photo={photo} onClick={() => setSelectedIndex(i)} />
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 py-6 border-t mt-6">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
                <ChevronLeft className="h-4 w-4 mr-1" /> Prev
              </Button>
              <span className="text-sm text-gray-500 font-medium">Page {page} of {totalPages}</span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
                Next <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </>
      )}

      {selectedIndex != null && photos[selectedIndex] && (
        <PhotoLightbox
          photo={photos[selectedIndex]}
          initialUrl={thumbCache.get(photos[selectedIndex].id) ?? null}
          onClose={() => setSelectedIndex(null)}
          onPrev={selectedIndex > 0 ? () => setSelectedIndex((p) => p! - 1) : undefined}
          onNext={selectedIndex < photos.length - 1 ? () => setSelectedIndex((p) => p! + 1) : undefined}
        />
      )}
    </div>
  );
}

function UnassignedTab({ onDataChanged }: { onDataChanged: () => void }) {
  const [projects, setProjects] = useState<CompanyCamProjectStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CompanyCamProjectStat | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ projects: CompanyCamProjectStat[] }>("/files/photos/unassigned-companycam")
      .then((d) => { if (!cancelled) setProjects(d.projects); })
      .catch((err) => console.error("Failed to load unassigned CompanyCam projects:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!search) return projects;
    const q = search.toLowerCase();
    return projects.filter(
      (p) => (p.companycamProjectName ?? "").toLowerCase().includes(q) || p.companycamProjectId.includes(q),
    );
  }, [projects, search]);

  const totalPhotos = useMemo(() => projects.reduce((s, p) => s + p.photoCount, 0), [projects]);

  if (selected)
    return (
      <UnassignedProjectPhotos
        project={selected}
        onBack={() => setSelected(null)}
        onAssigned={() => {
          setProjects((prev) => prev.filter((p) => p.companycamProjectId !== selected.companycamProjectId));
          setSelected(null);
          onDataChanged();
        }}
      />
    );

  return (
    <div className="px-6 py-4">
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Find a CompanyCam project..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 bg-white"
        />
      </div>
      {!loading && projects.length > 0 && (
        <p className="text-xs text-gray-500 mb-4">
          {projects.length} unassigned CompanyCam project{projects.length !== 1 ? "s" : ""} &bull; {totalPhotos} photo
          {totalPhotos !== 1 ? "s" : ""} not yet linked to a deal
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="rounded-full bg-gray-100 p-6 mb-4">
            <ImageIcon className="h-12 w-12 text-gray-300" />
          </div>
          <h2 className="text-lg font-semibold text-gray-700 mb-1">No unassigned photos</h2>
          <p className="text-sm text-gray-500">
            {search ? "Try a different search term" : "Rescued CompanyCam photos without a deal will appear here"}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((project) => (
            <CompanyCamProjectRow
              key={project.companycamProjectId}
              project={project}
              onClick={() => setSelected(project)}
              onAssigned={() => {
                setProjects((prev) => prev.filter((p) => p.companycamProjectId !== project.companycamProjectId));
                onDataChanged();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function PhotoFeedPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"projects" | "photos" | "unassigned">("projects");

  // ── Projects tab state ──
  const [projectStats, setProjectStats] = useState<ProjectStat[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<"all" | "my">("all");

  // ── Photos tab state ──
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [projectFilterId, setProjectFilterId] = useState("");
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  // Bumped after a successful unassigned-photo assignment so the Photos feed refetches (the newly-linked
  // photos otherwise wouldn't appear until the 30s new-photo poll).
  const [feedRefreshToken, setFeedRefreshToken] = useState(0);

  // Build filters for photo feed
  const feedFilters = useMemo<FeedFilters>(() => {
    const f: FeedFilters = { refreshToken: feedRefreshToken };
    if (dateFrom) f.dateFrom = new Date(dateFrom).toISOString();
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      f.dateTo = end.toISOString();
    }
    if (projectFilterId) f.dealId = projectFilterId;
    return f;
  }, [dateFrom, dateTo, projectFilterId, feedRefreshToken]);

  const { photos, page, totalPages, total, loading, newCount, loadNewPhotos, goToPage } =
    usePhotoFeed(feedFilters);

  const dateGroups = useMemo(() => groupPhotosByDate(photos), [photos]);

  // Fetch project stats
  const fetchProjectStats = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const data = await api<{ projects: ProjectStat[] }>(
        "/files/photos/project-stats"
      );
      setProjectStats(data.projects);
    } catch (err) {
      console.error("Failed to fetch project stats:", err);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  // After photos are assigned out of the Unassigned tab, refresh the Projects stats + the Photos feed so
  // their counts/lists aren't stale when the user switches tabs (Codex).
  const handleUnassignedDataChanged = useCallback(() => {
    void fetchProjectStats();
    setFeedRefreshToken((t) => t + 1);
  }, [fetchProjectStats]);

  useEffect(() => {
    fetchProjectStats();
  }, [fetchProjectStats]);

  // Filter projects by search
  const filteredProjects = useMemo(() => {
    let result = projectStats;
    if (projectSearch) {
      const q = projectSearch.toLowerCase();
      result = result.filter(
        (p) =>
          p.dealName.toLowerCase().includes(q) ||
          p.dealNumber.toLowerCase().includes(q) ||
          (p.propertyCity && p.propertyCity.toLowerCase().includes(q))
      );
    }
    return result;
  }, [projectStats, projectSearch, projectFilter]);

  // Unique uploaders for the Users filter dropdown
  const allUploaders = useMemo(() => {
    const set = new Set<string>();
    projectStats.forEach((p) => p.recentUploaders.forEach((u) => set.add(u)));
    return Array.from(set).sort();
  }, [projectStats]);

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="px-6 pt-6 pb-2">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">
          Photos
        </h1>

        {/* Tab pills */}
        <div className="flex gap-1 mt-4 bg-gray-200 rounded-full p-1 w-fit">
          <button
            type="button"
            onClick={() => setActiveTab("projects")}
            className={`px-5 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeTab === "projects"
                ? "bg-[#CC0000] text-white shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Projects
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("photos")}
            className={`px-5 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeTab === "photos"
                ? "bg-[#CC0000] text-white shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Photos
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("unassigned")}
            className={`px-5 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeTab === "unassigned"
                ? "bg-[#CC0000] text-white shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Unassigned
          </button>
        </div>
      </div>

      {/* New photos banner */}
      {newCount > 0 && activeTab === "photos" && (
        <div className="sticky top-0 z-30 mx-6 mb-3 mt-2 flex items-center justify-between rounded-lg bg-[#CC0000] px-4 py-2.5 text-white text-sm font-medium shadow-lg">
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

      {/* ─── Tab Content ─── */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "unassigned" ? (
          /* ═══════════════════ UNASSIGNED (CompanyCam) TAB ═══════════════════ */
          <UnassignedTab onDataChanged={handleUnassignedDataChanged} />
        ) : activeTab === "projects" ? (
          /* ═══════════════════ PROJECTS TAB ═══════════════════ */
          <div className="px-6 py-4">
            {/* Search + filter bar */}
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Find a project..."
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  className="pl-9 bg-white"
                />
              </div>
              <div className="flex gap-1 bg-gray-200 rounded-full p-0.5">
                <button
                  type="button"
                  onClick={() => setProjectFilter("all")}
                  className={`px-4 py-1 rounded-full text-xs font-medium transition-colors ${
                    projectFilter === "all"
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setProjectFilter("my")}
                  className={`px-4 py-1 rounded-full text-xs font-medium transition-colors ${
                    projectFilter === "my"
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  My Projects
                </button>
              </div>
            </div>

            {/* Project list */}
            {projectsLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="rounded-full bg-gray-100 p-6 mb-4">
                  <Camera className="h-12 w-12 text-gray-300" />
                </div>
                <h2 className="text-lg font-semibold text-gray-700 mb-1">
                  No projects found
                </h2>
                <p className="text-sm text-gray-500">
                  {projectSearch
                    ? "Try a different search term"
                    : "Upload photos to a deal to see it here"}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredProjects.map((project) => (
                  <ProjectRow
                    key={project.dealId}
                    project={project}
                    onClick={() => navigate(`/deals/${project.dealId}`)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          /* ═══════════════════ PHOTOS TAB ═══════════════════ */
          <div className="px-6 py-4">
            {/* Filters bar */}
            <div className="flex flex-wrap gap-3 mb-5">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                  Start Date
                </label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="bg-white w-[150px] h-9 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                  End Date
                </label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="bg-white w-[150px] h-9 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                  Project
                </label>
                <select
                  value={projectFilterId}
                  onChange={(e) => setProjectFilterId(e.target.value)}
                  className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 min-w-[180px]"
                >
                  <option value="">All Projects</option>
                  {projectStats.map((p) => (
                    <option key={p.dealId} value={p.dealId}>
                      {p.dealName}
                    </option>
                  ))}
                </select>
              </div>
              {(dateFrom || dateTo || projectFilterId) && (
                <div className="flex items-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDateFrom("");
                      setDateTo("");
                      setProjectFilterId("");
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700 h-9"
                  >
                    Clear Filters
                  </Button>
                </div>
              )}
            </div>

            {/* Photo grid by date */}
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
              </div>
            ) : photos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="rounded-full bg-gray-100 p-6 mb-4">
                  <Camera className="h-12 w-12 text-gray-300" />
                </div>
                <h2 className="text-lg font-semibold text-gray-700 mb-1">
                  No photos yet
                </h2>
                <p className="text-sm text-gray-500">
                  Photos uploaded to deals will appear here
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-4">
                  {total} photo{total !== 1 ? "s" : ""}
                </p>

                <div className="space-y-8">
                  {dateGroups.map((group) => (
                    <div key={group.dateKey}>
                      {/* Date header */}
                      <div className="flex items-center gap-3 mb-3 pb-2 border-b border-gray-200">
                        <h3 className="text-sm font-semibold text-gray-800">
                          {group.dateLabel}
                        </h3>
                        <span className="text-xs text-gray-400">
                          {group.photos.length} photo
                          {group.photos.length !== 1 ? "s" : ""}
                        </span>
                      </div>

                      {/* Photo grid */}
                      <div className="flex flex-wrap gap-2">
                        {group.photos.map(({ photo, globalIndex }) => (
                          <div
                            key={photo.id}
                            className="w-[calc(50%-4px)] sm:w-[calc(25%-6px)] md:w-[calc(20%-6.4px)] lg:w-[calc(16.666%-6.7px)] xl:w-[150px]"
                          >
                            <PhotoGridCard
                              photo={photo}
                              onClick={() => setSelectedPhotoIndex(globalIndex)}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-4 py-6 border-t mt-6">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => goToPage(page - 1)}
                      disabled={page <= 1}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" /> Prev
                    </Button>
                    <span className="text-sm text-gray-500 font-medium">
                      Page {page} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => goToPage(page + 1)}
                      disabled={page >= totalPages}
                    >
                      Next <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {selectedPhotoIndex != null && photos[selectedPhotoIndex] && (
        <PhotoLightbox
          photo={photos[selectedPhotoIndex]}
          initialUrl={thumbCache.get(photos[selectedPhotoIndex].id) ?? null}
          onClose={() => setSelectedPhotoIndex(null)}
          onPrev={
            selectedPhotoIndex > 0
              ? () => setSelectedPhotoIndex((p) => p! - 1)
              : undefined
          }
          onNext={
            selectedPhotoIndex < photos.length - 1
              ? () => setSelectedPhotoIndex((p) => p! + 1)
              : undefined
          }
        />
      )}
    </div>
  );
}
