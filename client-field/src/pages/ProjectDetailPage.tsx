import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Camera, CheckCircle2, ChevronLeft, ChevronRight, Download, Eye, FileText, Filter, Star, X } from "lucide-react";
import { api, getActiveOfficeId } from "../lib/api";
import { useAuth } from "../lib/auth";
import { triggerPhotoDownloads, type PhotoDownload } from "../lib/download";
import { BrandLogo } from "../components/BrandLogo";
import { Button, TextInput } from "../components/ui";
import { ReportBuilder } from "../components/ReportBuilder";
import { ZoomableImage } from "../components/ZoomableImage";
import {
  categoryLabel,
  filterPhotos,
  groupPhotos,
  isProjectOffOffice,
  LEGACY_PHOTO_CATEGORIES,
  PHOTO_CATEGORIES,
  type FieldPhoto,
  type FieldProject,
  type PhotoGrouping,
} from "../lib/field-projects";

const GROUP_SEQUENCE: PhotoGrouping[] = ["date", "category", "uploader", "none"];
// The download-urls endpoint caps each request at 200 ids (shared with /share). Chunk bulk downloads so a
// "Select all" on a large project succeeds instead of 400-ing.
const DOWNLOAD_BATCH_SIZE = 200;

// Photos are grouped by date across the whole project, so we load EVERY page (not just the first 200) —
// the server batches each photo's display URLs, so a 400-photo deal is ~2 fast requests. Page 1 reveals
// totalPages; the rest fetch in BOUNDED chunks (not one big fan-out) so we don't burst the API, and each
// chunk is allSettled so a single 429/5xx drops just that page instead of aborting the whole gallery.
const FIELD_PHOTOS_PER_PAGE = 200;
const FIELD_PHOTOS_FETCH_CONCURRENCY = 4;
async function fetchAllProjectPhotos(projectId: string): Promise<{ photos: FieldPhoto[]; partial: boolean }> {
  const first = await api<{ photos: FieldPhoto[]; pagination: { totalPages: number } }>(
    `/field/projects/${projectId}/photos?page=1&perPage=${FIELD_PHOTOS_PER_PAGE}`,
  );
  const all = [...first.photos];
  const totalPages = first.pagination?.totalPages ?? 1;
  const remaining = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 2);
  // Track dropped pages: keep the non-blanking behavior (show what loaded), but report `partial` so the
  // caller can warn and block report/share — an incomplete photo set would silently omit photos otherwise.
  let partial = false;
  for (let i = 0; i < remaining.length; i += FIELD_PHOTOS_FETCH_CONCURRENCY) {
    const chunk = remaining.slice(i, i + FIELD_PHOTOS_FETCH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((page) =>
        api<{ photos: FieldPhoto[] }>(`/field/projects/${projectId}/photos?page=${page}&perPage=${FIELD_PHOTOS_PER_PAGE}`),
      ),
    );
    results.forEach((r) => {
      if (r.status === "fulfilled") all.push(...r.value.photos);
      else partial = true;
    });
  }
  return { photos: all, partial };
}

export function ProjectDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState<FieldProject | null>(null);
  const [photos, setPhotos] = useState<FieldPhoto[]>([]);
  const [reports, setReports] = useState<Array<{ id: string; title: string; createdAt: string; description: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [grouping, setGrouping] = useState<PhotoGrouping>("date");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [uploaderIds, setUploaderIds] = useState<string[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [reportBuilderOpen, setReportBuilderOpen] = useState(false);
  // True when one or more photo pages failed to load — the gallery shows what loaded, but report/share are
  // blocked so we never generate from an incomplete set.
  const [photosPartial, setPhotosPartial] = useState(false);
  // Multi-select mode for bulk download: tapping a photo toggles selection instead of opening the viewer.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(() => new Set());

  // Fetch presigned high-res download URLs for the given photos and save them to the computer. Used by the
  // per-photo quick-download button (one id) and the bulk "Download (N)" action. The endpoint caps each
  // request at 200 ids (shared with /share), so a "Select all" on a 200+ photo project is chunked here.
  async function downloadPhotos(ids: string[]) {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0 || !id) return;
    setDownloadingIds((current) => new Set([...current, ...unique]));
    try {
      const all: PhotoDownload[] = [];
      for (let i = 0; i < unique.length; i += DOWNLOAD_BATCH_SIZE) {
        const batch = unique.slice(i, i + DOWNLOAD_BATCH_SIZE);
        const { downloads } = await api<{ downloads: PhotoDownload[] }>(`/field/projects/${id}/photos/download-urls`, {
          json: { photoIds: batch },
        });
        all.push(...downloads);
      }
      triggerPhotoDownloads(all);
    } catch {
      setError("Couldn't prepare the download. Please try again.");
    } finally {
      setDownloadingIds((current) => {
        const next = new Set(current);
        unique.forEach((photoId) => next.delete(photoId));
        return next;
      });
    }
  }

  function toggleSelected(photoId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  function exitSelection() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  async function loadDetail() {
    setLoading(true);
    setError(null);
    try {
      const [projectResult, photosResult, reportsResult] = await Promise.allSettled([
        // Fetch this one project by id — NOT a scan of the active list. Photos-first ordering pushes
        // zero-photo projects past the list window, so a list scan would 404 them (and drop the office
        // context the off-office write guard depends on).
        api<{ project: FieldProject }>(`/field/projects/${id}`),
        fetchAllProjectPhotos(id),
        api<{ reports: Array<{ id: string; title: string; createdAt: string; description: string | null }> }>(`/field/projects/${id}/reports`),
      ]);
      if (projectResult.status !== "fulfilled" || photosResult.status !== "fulfilled") {
        throw new Error("Failed to load project");
      }
      setProject(projectResult.value.project ?? null);
      setPhotos(photosResult.value.photos);
      setPhotosPartial(photosResult.value.partial);
      setReports(reportsResult.status === "fulfilled" ? reportsResult.value.reports : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDetail();
  }, [id]);

  async function toggleStar() {
    if (!project) return;
    const next = !project.starred;
    setProject({ ...project, starred: next });
    try {
      await api(`/field/projects/${project.id}/star`, { method: next ? "POST" : "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update star");
      setProject(project);
    }
  }

  const uploaders = useMemo(() => {
    const map = new Map<string, string>();
    photos.forEach((photo) => map.set(photo.uploadedBy, photo.uploaderName || "Unknown"));
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [photos]);
  const availableTags = useMemo(() => {
    const map = new Map<string, string>();
    photos.forEach((photo) => {
      for (const tag of photo.tags ?? []) {
        const normalized = tag.trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (!map.has(key)) map.set(key, normalized);
      }
    });
    return Array.from(map.values()).sort((left, right) => left.localeCompare(right));
  }, [photos]);
  const filteredPhotos = useMemo(() => filterPhotos(photos, { categories, tags, uploaderIds, from, to }), [categories, from, photos, tags, to, uploaderIds]);
  // Surface a legacy category chip only when a loaded photo still carries it, so
  // historical photos stay filterable without offering retired values for new captures.
  const legacyCategoriesInUse = useMemo(() => {
    // Derive from the same token filterPhotos matches on (photoCategory else
    // subcategory) so a legacy chip appears whenever a photo — including a
    // subcategory-backed legacy one — is actually filterable by it.
    const present = new Set(photos.map((photo) => photo.photoCategory ?? photo.subcategory ?? undefined));
    return LEGACY_PHOTO_CATEGORIES.filter((category) => present.has(category.value));
  }, [photos]);
  const groupedPhotos = useMemo(() => groupPhotos(filteredPhotos, grouping), [filteredPhotos, grouping]);
  const selectedIndex = selectedPhotoId ? filteredPhotos.findIndex((photo) => photo.id === selectedPhotoId) : -1;
  const selectedPhoto = selectedIndex >= 0 ? filteredPhotos[selectedIndex] : null;

  // Cross-office projects are view-only until cross-office writes ship: the single-office star / report /
  // capture writes would 404 against the active office's schema, so suppress them and explain why.
  const writableOfficeId = getActiveOfficeId() ?? user?.tenantId;
  const offOffice = !!project && isProjectOffOffice(project, writableOfficeId);

  if (loading) return <div className="space-y-3">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-20 animate-pulse rounded-md bg-muted" />)}</div>;

  return (
    <section className="space-y-4">
      <header className="sticky top-[72px] z-10 -mx-4 border-b border-border bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <button type="button" aria-label="Back to projects" className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-muted" onClick={() => navigate("/projects")}>
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-black">{project?.name ?? "Project"}</h1>
            <p className="truncate text-sm text-muted-foreground">{project?.propertyAddress ?? "No address on file"}</p>
          </div>
          {offOffice ? (
            <span className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground" aria-label={`Managed by the ${project?.officeSlug} office — view only`}>
              <Eye className="h-6 w-6" />
            </span>
          ) : (
            <button type="button" aria-label={project?.starred ? "Unstar project" : "Star project"} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-primary" onClick={() => void toggleStar()}>
              <Star className={project?.starred ? "h-6 w-6 fill-primary" : "h-6 w-6"} />
            </button>
          )}
        </div>
        {project ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <p className="font-semibold text-foreground">
              {project.projectNumber ? `Project # ${project.projectNumber}` : "Project pending"}
            </p>
            <span className="rounded-full bg-muted px-2 py-0.5 font-semibold text-muted-foreground">{project.stage}</span>
            {offOffice ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold uppercase text-amber-700">{project.officeSlug} · view-only</span>
            ) : null}
          </div>
        ) : null}
        {offOffice ? (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            This project is managed by the {project?.officeSlug} office. You can view its photos and reports here; starring, report generation, and photo capture are available from that office.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={photosPartial}
              title={photosPartial ? "Some photos failed to load — reload before generating a report" : undefined}
              onClick={() => setReportBuilderOpen(true)}
            >
              <FileText className="mr-2 h-4 w-4" />
              Generate Report
            </Button>
          </div>
        )}
        {photosPartial ? (
          <p className="mt-2 flex items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            <span>Some photos couldn’t be loaded, so report generation is paused to avoid omitting any. Reload to try again.</span>
            <Button variant="ghost" onClick={() => void loadDetail()}>Reload</Button>
          </p>
        ) : null}
      </header>

      {error ? <p className="rounded-md bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}

      <section className="rounded-2xl border border-border bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-white shadow-sm">
              <BrandLogo className="h-6 w-auto" alt="T Rock Construction reports" surfaceClassName="rounded-lg px-2 py-1.5" />
            </div>
            <div>
            <h2 className="text-lg font-black">Reports</h2>
            <p className="text-sm text-muted-foreground">Generated photo PDFs for this project.</p>
            </div>
          </div>
          {!offOffice ? (
            <Button
              variant="ghost"
              disabled={photosPartial}
              title={photosPartial ? "Some photos failed to load — reload before generating a report" : undefined}
              onClick={() => setReportBuilderOpen(true)}
            >
              <FileText className="mr-2 h-4 w-4" />
              Build
            </Button>
          ) : null}
        </div>
        {reports.length === 0 ? (
          <p className="text-sm font-semibold text-muted-foreground">No reports yet.</p>
        ) : (
          <div className="space-y-2">
            {reports.map((report) => (
              <button
                key={report.id}
                type="button"
                className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-3 text-left"
                onClick={async () => {
                  const result = await api<{ url: string }>(`/field/reports/${report.id}/download`);
                  window.open(result.url, "_blank");
                }}
              >
                <div className="min-w-0">
                  <p className="truncate font-bold">{report.title}</p>
                  <p className="truncate text-sm text-muted-foreground">{new Date(report.createdAt).toLocaleString()}</p>
                </div>
                <Download className="h-5 w-5 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="sticky top-[154px] z-10 -mx-4 flex gap-2 overflow-x-auto border-b border-border bg-white px-4 py-2">
        <button
          type="button"
          className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${categories.length === 0 ? "bg-primary text-primary-foreground" : "bg-muted"}`}
          onClick={() => setCategories([])}
        >
          All categories
        </button>
        {PHOTO_CATEGORIES.map((category) => (
          <button
            key={category.value}
            type="button"
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${categories.includes(category.value) ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            onClick={() => setCategories((current) => current.includes(category.value) ? current.filter((value) => value !== category.value) : [...current, category.value])}
          >
            {category.label}
          </button>
        ))}
        {legacyCategoriesInUse.map((category) => (
          <button
            key={category.value}
            type="button"
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${categories.includes(category.value) ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            onClick={() => setCategories((current) => current.includes(category.value) ? current.filter((value) => value !== category.value) : [...current, category.value])}
          >
            {category.label} (legacy)
          </button>
        ))}
        {availableTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`shrink-0 rounded-full border px-3 py-2 text-sm font-bold ${tags.includes(tag) ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground"}`}
            onClick={() => setTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}
          >
            #{tag}
          </button>
        ))}
        <button type="button" className="shrink-0 rounded-full bg-muted px-3 py-2 text-sm font-bold" onClick={() => setGrouping(GROUP_SEQUENCE[(GROUP_SEQUENCE.indexOf(grouping) + 1) % GROUP_SEQUENCE.length])}>
          {grouping[0].toUpperCase() + grouping.slice(1)}
        </button>
        <button type="button" aria-label="Open filters" className="relative shrink-0 rounded-full bg-muted px-3 py-2" onClick={() => setDrawerOpen(true)}>
          <Filter className="h-5 w-5" />
          {(from || to || uploaderIds.length > 0) ? <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary" /> : null}
        </button>
        {filteredPhotos.length > 0 ? (
          <button
            type="button"
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${selecting ? "bg-primary text-white" : "bg-muted"}`}
            onClick={() => (selecting ? exitSelection() : setSelecting(true))}
          >
            {selecting ? "Cancel" : "Select"}
          </button>
        ) : null}
      </div>

      {/* Bulk-download action bar — visible in selection mode. */}
      {selecting ? (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-md border border-border bg-white px-3 py-2 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold">{selectedIds.size} selected</span>
            <button
              type="button"
              className="text-sm font-semibold text-primary"
              onClick={() => setSelectedIds(new Set(filteredPhotos.map((photo) => photo.id)))}
            >
              Select all
            </button>
            {selectedIds.size > 0 ? (
              <button type="button" className="text-sm font-semibold text-muted-foreground" onClick={() => setSelectedIds(new Set())}>
                Clear
              </button>
            ) : null}
          </div>
          <Button
            disabled={selectedIds.size === 0 || downloadingIds.size > 0}
            onClick={() => void downloadPhotos(Array.from(selectedIds))}
          >
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />
            {downloadingIds.size > 0 ? "Preparing…" : `Download${selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}`}
          </Button>
        </div>
      ) : null}

      {filteredPhotos.length === 0 ? (
        <div className="rounded-md bg-muted p-5 text-center">
          <p className="font-semibold text-muted-foreground">No photos in this project yet.</p>
          {!offOffice ? (
            <Button className="mt-4" onClick={() => navigate(`/capture?dealId=${id}`)}>
              <Camera className="mr-2 h-5 w-5" aria-hidden="true" />
              Add photos
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-5">
          {groupedPhotos.map((group) => (
            <section key={group.label}>
              <h2 className="mb-2 text-sm font-black text-muted-foreground">{group.label}</h2>
              <div className="grid grid-cols-3 gap-2 min-[480px]:grid-cols-4">
                {group.photos.map((photo) => {
                  const isSelected = selectedIds.has(photo.id);
                  return (
                    <div key={photo.id} className="text-left">
                      <span className="relative block aspect-square overflow-hidden rounded-md bg-muted">
                        <button
                          type="button"
                          className="block h-full w-full"
                          aria-label={selecting ? `${isSelected ? "Deselect" : "Select"} ${photo.displayName}` : `Open ${photo.displayName}`}
                          onClick={() => (selecting ? toggleSelected(photo.id) : setSelectedPhotoId(photo.id))}
                        >
                          {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.displayName} loading="lazy" className="h-full w-full object-cover" /> : null}
                        </button>
                        {photo.photoCategory ? <span className="pointer-events-none absolute bottom-1 right-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold text-white">{categoryLabel(photo.photoCategory)}</span> : null}
                        {/* Per-photo quick download — high-res original, straight to the computer. */}
                        {!selecting ? (
                          <button
                            type="button"
                            aria-label={`Download ${photo.displayName}`}
                            className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80 disabled:opacity-60"
                            disabled={downloadingIds.has(photo.id)}
                            onClick={() => void downloadPhotos([photo.id])}
                          >
                            <Download className="h-4 w-4" />
                          </button>
                        ) : (
                          <span className={`pointer-events-none absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded-full border-2 ${isSelected ? "border-primary bg-primary text-white" : "border-white/90 bg-black/40 text-transparent"}`}>
                            <CheckCircle2 className="h-4 w-4" />
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block truncate text-xs font-semibold text-muted-foreground">{photo.description || photo.uploaderName}</span>
                      {(photo.tags?.length ?? 0) > 0 ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {photo.tags!.slice(0, 2).map((tag) => (
                            <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">#{tag}</span>
                          ))}
                          {photo.tags!.length > 2 ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">+{photo.tags!.length - 2}</span> : null}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {!offOffice ? (
        <Button
          aria-label="Add photos"
          className="fixed bottom-24 right-4 z-20 h-14 rounded-full px-5 shadow-lg"
          onClick={() => navigate(`/capture?dealId=${id}`)}
        >
          <Camera className="mr-2 h-5 w-5" aria-hidden="true" />
          Add photos
        </Button>
      ) : null}

      {drawerOpen ? (
        <FilterDrawer
          from={from}
          to={to}
          uploaderIds={uploaderIds}
          uploaders={uploaders}
          onClose={() => setDrawerOpen(false)}
          onApply={(next) => {
            setFrom(next.from);
            setTo(next.to);
            setUploaderIds(next.uploaderIds);
            setDrawerOpen(false);
          }}
          onClear={() => {
            setFrom("");
            setTo("");
            setUploaderIds([]);
          }}
        />
      ) : null}

      {selectedPhoto ? (
        <FieldPhotoViewer
          photo={selectedPhoto}
          onClose={() => setSelectedPhotoId(null)}
          onDownload={() => void downloadPhotos([selectedPhoto.id])}
          downloading={downloadingIds.has(selectedPhoto.id)}
          onPrev={selectedIndex > 0 ? () => setSelectedPhotoId(filteredPhotos[selectedIndex - 1].id) : undefined}
          onNext={selectedIndex < filteredPhotos.length - 1 ? () => setSelectedPhotoId(filteredPhotos[selectedIndex + 1].id) : undefined}
        />
      ) : null}

      <ReportBuilder
        isOpen={reportBuilderOpen}
        projectId={id}
        projectName={project?.name ?? project?.projectNumber ?? "Project"}
        creatorName={[user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "Field User"}
        photos={photos}
        onClose={() => setReportBuilderOpen(false)}
        onGenerated={() => {
          setReportBuilderOpen(false);
          void loadDetail();
        }}
      />
    </section>
  );
}

function FilterDrawer({
  from,
  to,
  uploaderIds,
  uploaders,
  onApply,
  onClear,
  onClose,
}: {
  from: string;
  to: string;
  uploaderIds: string[];
  uploaders: Array<{ id: string; name: string }>;
  onApply: (value: { from: string; to: string; uploaderIds: string[] }) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [draftUploaders, setDraftUploaders] = useState(uploaderIds);
  return (
    <div className="fixed inset-0 z-40 bg-black/40" role="dialog" aria-label="Photo filters">
      <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-4 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-black">Filters</h2>
          <button type="button" aria-label="Close filters" onClick={onClose}><X className="h-6 w-6" /></button>
        </div>
        <div className="space-y-4">
          <label className="block space-y-2"><span className="text-sm font-bold">From</span><TextInput type="date" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} /></label>
          <label className="block space-y-2"><span className="text-sm font-bold">To</span><TextInput type="date" value={draftTo} onChange={(event) => setDraftTo(event.target.value)} /></label>
          <div>
            <p className="mb-2 text-sm font-bold">Uploaders</p>
            <div className="space-y-1">
              {uploaders.map((uploader) => (
                <label key={uploader.id} className="flex min-h-11 items-center gap-3 rounded-md bg-muted px-3">
                  <input
                    type="checkbox"
                    checked={draftUploaders.includes(uploader.id)}
                    onChange={() => setDraftUploaders((current) => current.includes(uploader.id) ? current.filter((id) => id !== uploader.id) : [...current, uploader.id])}
                  />
                  <span className="font-semibold">{uploader.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDraftFrom("");
                setDraftTo("");
                setDraftUploaders([]);
                onClear();
                onApply({ from: "", to: "", uploaderIds: [] });
              }}
            >
              Clear all
            </Button>
            <Button onClick={() => onApply({ from: draftFrom, to: draftTo, uploaderIds: draftUploaders })}>Apply</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldPhotoViewer({ photo, onClose, onDownload, downloading, onPrev, onNext }: { photo: FieldPhoto; onClose: () => void; onDownload: () => void; downloading: boolean; onPrev?: () => void; onNext?: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  // While the image is pinch-zoomed, the one-finger drag pans the photo — so suppress swipe-to-navigate.
  const [imageZoomed, setImageZoomed] = useState(false);
  const source = photo.addressSource === "exif" ? "From photo" : photo.addressSource === "live_gps" ? "Captured at upload" : photo.addressSource === "deal_fallback" ? "Project address" : photo.addressSource === "manual_override" ? "Manually set" : "No source";
  const viewerUrl = photo.fullImageUrl ?? photo.imageUrl;

  return (
    <div
      className="fixed inset-0 z-50 bg-black text-white"
      // Only arm swipe-to-navigate for a genuine SINGLE-finger gesture — a pinch (2nd finger) must never
      // navigate, even at 1x before the zoom state has updated.
      onTouchStart={(event) => setTouchStart(imageZoomed || event.touches.length > 1 ? null : event.touches[0]?.clientX ?? null)}
      onTouchMove={(event) => {
        if (event.touches.length > 1) setTouchStart(null);
      }}
      onTouchEnd={(event) => {
        if (touchStart == null || imageZoomed || event.touches.length > 0) return;
        const diff = (event.changedTouches[0]?.clientX ?? touchStart) - touchStart;
        if (diff > 50) onPrev?.();
        if (diff < -50) onNext?.();
        setTouchStart(null);
      }}
    >
      <button type="button" aria-label="Close photo viewer" className="absolute right-4 top-4 z-10 rounded-full bg-black/60 p-2" onClick={onClose}><X className="h-6 w-6" /></button>
      <button type="button" aria-label={`Download ${photo.displayName}`} className="absolute right-16 top-4 z-10 rounded-full bg-black/60 p-2 disabled:opacity-60" disabled={downloading} onClick={onDownload}><Download className="h-6 w-6" /></button>
      {onPrev && !imageZoomed ? <button type="button" aria-label="Previous photo" className="absolute left-2 top-1/2 z-10 rounded-full bg-black/60 p-2" onClick={onPrev}><ChevronLeft /></button> : null}
      {onNext && !imageZoomed ? <button type="button" aria-label="Next photo" className="absolute right-2 top-1/2 z-10 rounded-full bg-black/60 p-2" onClick={onNext}><ChevronRight /></button> : null}
      {/* A CONFIRMED single tap toggles details; pinch/double-tap/drag zoom + pan inside ZoomableImage (it
          distinguishes a real tap from a gesture, so zooming/panning no longer flips the details sheet). */}
      <div className="flex h-full w-full items-center justify-center px-3 pb-56 pt-12">
        {viewerUrl ? (
          <ZoomableImage key={photo.id} src={viewerUrl} alt={photo.displayName} onZoomedChange={setImageZoomed} onTap={() => setDetailsOpen((open) => !open)} />
        ) : (
          <span>Image unavailable</span>
        )}
      </div>
      {detailsOpen ? (
        <aside className="absolute inset-x-0 bottom-0 max-h-[50vh] overflow-y-auto rounded-t-2xl bg-white p-4 text-foreground">
          <h2 className="text-xl font-black">{photo.description || photo.displayName}</h2>
          <p className="mt-1 text-sm font-semibold text-muted-foreground">{categoryLabel(photo.photoCategory ?? photo.subcategory)} • {photo.uploaderName}</p>
          {(photo.tags?.length ?? 0) > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {photo.tags!.map((tag) => (
                <span key={tag} className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">#{tag}</span>
              ))}
            </div>
          ) : null}
          <dl className="mt-4 grid gap-3 text-sm">
            <Meta label="Taken" value={photo.takenAt ? new Date(photo.takenAt).toLocaleString() : "Same as uploaded"} />
            <Meta label="Uploaded" value={new Date(photo.createdAt).toLocaleString()} />
            <Meta label="Address" value={photo.address || "No address"} />
            <Meta label="Coordinates" value={photo.latitude && photo.longitude ? `${Number(photo.latitude).toFixed(6)}, ${Number(photo.longitude).toFixed(6)}` : "No coordinates"} />
            <Meta label="Source" value={source} />
            {photo.procoreSyncStatus ? <Meta label="Procore" value={photo.procoreSyncStatus} /> : null}
            <details className="rounded-md bg-muted p-3">
              <summary className="font-bold">History</summary>
              <p className="mt-2 text-muted-foreground">Audit history is read-only in CRM for now.</p>
            </details>
          </dl>
        </aside>
      ) : null}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-black uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}
