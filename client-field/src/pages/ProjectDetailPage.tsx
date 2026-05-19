import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Camera, ChevronLeft, ChevronRight, Download, FileText, Filter, Star, X } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, TextInput } from "../components/ui";
import { ReportBuilder } from "../components/ReportBuilder";
import {
  categoryLabel,
  filterPhotos,
  groupPhotos,
  PHOTO_CATEGORIES,
  type FieldPhoto,
  type FieldProject,
  type PhotoGrouping,
} from "../lib/field-projects";

const GROUP_SEQUENCE: PhotoGrouping[] = ["date", "category", "uploader", "none"];

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

  async function loadDetail() {
    setLoading(true);
    setError(null);
    try {
      const [projectsResult, photosResult, reportsResult] = await Promise.allSettled([
        api<{ projects: FieldProject[] }>("/field/projects?status=active&page=1&perPage=100"),
        api<{ photos: FieldPhoto[] }>(`/field/projects/${id}/photos`),
        api<{ reports: Array<{ id: string; title: string; createdAt: string; description: string | null }> }>(`/field/projects/${id}/reports`),
      ]);
      if (projectsResult.status !== "fulfilled" || photosResult.status !== "fulfilled") {
        throw new Error("Failed to load project");
      }
      setProject(projectsResult.value.projects.find((item) => item.id === id) ?? null);
      setPhotos(photosResult.value.photos);
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
  const groupedPhotos = useMemo(() => groupPhotos(filteredPhotos, grouping), [filteredPhotos, grouping]);
  const selectedIndex = selectedPhotoId ? filteredPhotos.findIndex((photo) => photo.id === selectedPhotoId) : -1;
  const selectedPhoto = selectedIndex >= 0 ? filteredPhotos[selectedIndex] : null;

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
          <button type="button" aria-label={project?.starred ? "Unstar project" : "Star project"} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-primary" onClick={() => void toggleStar()}>
            <Star className={project?.starred ? "h-6 w-6 fill-primary" : "h-6 w-6"} />
          </button>
        </div>
        {project ? (
          <p className="mt-2 text-sm font-semibold text-muted-foreground">{project.dealNumber} • <span className="rounded-full bg-muted px-2 py-0.5">{project.stage}</span></p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setReportBuilderOpen(true)}>
            <FileText className="mr-2 h-4 w-4" />
            Generate Report
          </Button>
        </div>
      </header>

      {error ? <p className="rounded-md bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}

      <section className="rounded-2xl border border-border bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black">Reports</h2>
            <p className="text-sm text-muted-foreground">Generated photo PDFs for this project.</p>
          </div>
          <Button variant="ghost" onClick={() => setReportBuilderOpen(true)}>
            <FileText className="mr-2 h-4 w-4" />
            Build
          </Button>
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
      </div>

      {filteredPhotos.length === 0 ? (
        <div className="rounded-md bg-muted p-5 text-center">
          <p className="font-semibold text-muted-foreground">No photos in this project yet.</p>
          <Button className="mt-4" onClick={() => navigate(`/capture?dealId=${id}`)}>
            <Camera className="mr-2 h-5 w-5" aria-hidden="true" />
            Add photos
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          {groupedPhotos.map((group) => (
            <section key={group.label}>
              <h2 className="mb-2 text-sm font-black text-muted-foreground">{group.label}</h2>
              <div className="grid grid-cols-3 gap-2 min-[480px]:grid-cols-4">
                {group.photos.map((photo) => (
                  <button key={photo.id} type="button" className="text-left" onClick={() => setSelectedPhotoId(photo.id)}>
                    <span className="relative block aspect-square overflow-hidden rounded-md bg-muted">
                      {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.displayName} loading="lazy" className="h-full w-full object-cover" /> : null}
                      {photo.photoCategory ? <span className="absolute bottom-1 right-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold text-white">{categoryLabel(photo.photoCategory)}</span> : null}
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
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Button
        aria-label="Add photos"
        className="fixed bottom-24 right-4 z-20 h-14 rounded-full px-5 shadow-lg"
        onClick={() => navigate(`/capture?dealId=${id}`)}
      >
        <Camera className="mr-2 h-5 w-5" aria-hidden="true" />
        Add photos
      </Button>

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
          onPrev={selectedIndex > 0 ? () => setSelectedPhotoId(filteredPhotos[selectedIndex - 1].id) : undefined}
          onNext={selectedIndex < filteredPhotos.length - 1 ? () => setSelectedPhotoId(filteredPhotos[selectedIndex + 1].id) : undefined}
        />
      ) : null}

      <ReportBuilder
        isOpen={reportBuilderOpen}
        projectId={id}
        projectName={project?.name ?? project?.dealNumber ?? "Project"}
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

function FieldPhotoViewer({ photo, onClose, onPrev, onNext }: { photo: FieldPhoto; onClose: () => void; onPrev?: () => void; onNext?: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const source = photo.addressSource === "exif" ? "From photo" : photo.addressSource === "live_gps" ? "Captured at upload" : photo.addressSource === "deal_fallback" ? "Project address" : photo.addressSource === "manual_override" ? "Manually set" : "No source";

  return (
    <div
      className="fixed inset-0 z-50 bg-black text-white"
      onTouchStart={(event) => setTouchStart(event.touches[0]?.clientX ?? null)}
      onTouchEnd={(event) => {
        if (touchStart == null) return;
        const diff = (event.changedTouches[0]?.clientX ?? touchStart) - touchStart;
        if (diff > 50) onPrev?.();
        if (diff < -50) onNext?.();
        setTouchStart(null);
      }}
    >
      <button type="button" aria-label="Close photo viewer" className="absolute right-4 top-4 z-10 rounded-full bg-black/60 p-2" onClick={onClose}><X className="h-6 w-6" /></button>
      {onPrev ? <button type="button" aria-label="Previous photo" className="absolute left-2 top-1/2 z-10 rounded-full bg-black/60 p-2" onClick={onPrev}><ChevronLeft /></button> : null}
      {onNext ? <button type="button" aria-label="Next photo" className="absolute right-2 top-1/2 z-10 rounded-full bg-black/60 p-2" onClick={onNext}><ChevronRight /></button> : null}
      <button type="button" className="flex h-full w-full items-center justify-center px-3 pb-56 pt-12" onClick={() => setDetailsOpen((open) => !open)}>
        {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.displayName} className="max-h-full max-w-full object-contain" /> : <span>Image unavailable</span>}
      </button>
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
