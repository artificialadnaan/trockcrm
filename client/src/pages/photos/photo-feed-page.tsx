import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Camera,
  Image as ImageIcon,
  Search,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { usePhotoFeed, type FeedFilters, type FeedPhoto } from "@/hooks/use-photo-feed";
import { PhotoLightbox } from "@/components/photos/photo-lightbox";

// ─── Types ──────────────────────────────────────────────────────────────────

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

function setThumbCache(key: string, value: string) {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    // Delete oldest entry (first key in insertion order)
    const firstKey = thumbCache.keys().next().value;
    if (firstKey) thumbCache.delete(firstKey);
  }
  thumbCache.set(key, value);
}

function useThumbnailUrl(photo: FeedPhoto): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    if (photo.externalThumbnailUrl) return photo.externalThumbnailUrl;
    if (photo.externalUrl) return photo.externalUrl;
    return thumbCache.get(photo.id) ?? null;
  });

  useEffect(() => {
    if (url) return;
    let cancelled = false;

    api<{ url: string }>(`/files/${photo.id}/download`)
      .then((data) => {
        setThumbCache(photo.id, data.url);
        if (!cancelled) setUrl(data.url);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [photo.id, url]);

  return url;
}

/** Fetch a thumbnail URL by file ID (for project row thumbnails) */
function usePhotoIdThumbnail(photoId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    photoId ? thumbCache.get(photoId) ?? null : null
  );

  useEffect(() => {
    if (!photoId || url) return;
    let cancelled = false;

    api<{ url: string }>(`/files/${photoId}/download`)
      .then((data) => {
        setThumbCache(photoId, data.url);
        if (!cancelled) setUrl(data.url);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [photoId, url]);

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
  // Load thumbnails for the recent photos strip
  const thumb1 = usePhotoIdThumbnail(project.recentPhotoIds[0]);
  const thumb2 = usePhotoIdThumbnail(project.recentPhotoIds[1]);
  const thumb3 = usePhotoIdThumbnail(project.recentPhotoIds[2]);
  const thumb4 = usePhotoIdThumbnail(project.recentPhotoIds[3]);
  const thumb5 = usePhotoIdThumbnail(project.recentPhotoIds[4]);
  const recentThumbs = [thumb1, thumb2, thumb3, thumb4, thumb5].filter(
    (_, i) => i < project.recentPhotoIds.length
  );

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
          {thumb1 ? (
            <img
              src={thumb1}
              alt={project.dealName}
              className="h-full w-full object-cover"
              loading="lazy"
            />
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
          recentThumbs.map((thumbUrl, i) => (
            <div
              key={project.recentPhotoIds[i]}
              className="h-[72px] w-[72px] rounded-md overflow-hidden bg-gray-100 shrink-0"
            >
              {thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center">
                  <ImageIcon className="h-4 w-4 text-gray-300" />
                </div>
              )}
            </div>
          ))
        )}
      </div>
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
  const thumbUrl = useThumbnailUrl(photo);
  const timeStr = formatTime(photo.takenAt || photo.createdAt);

  return (
    <div className="cursor-pointer group" onClick={onClick}>
      {/* Thumbnail */}
      <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-gray-100">
        {thumbUrl ? (
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

// ─── Main Component ─────────────────────────────────────────────────────────

export function PhotoFeedPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"projects" | "photos">("projects");

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

  // Build filters for photo feed
  const feedFilters = useMemo<FeedFilters>(() => {
    const f: FeedFilters = {};
    if (dateFrom) f.dateFrom = new Date(dateFrom).toISOString();
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      f.dateTo = end.toISOString();
    }
    if (projectFilterId) f.dealId = projectFilterId;
    return f;
  }, [dateFrom, dateTo, projectFilterId]);

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
        {activeTab === "projects" ? (
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
