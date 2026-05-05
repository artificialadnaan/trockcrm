import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, Check, FolderOpen, ImagePlus, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { PHOTO_CATEGORIES, type FieldProject } from "@/lib/field-projects";
import {
  extractPhotoMetadata,
  fileToDataUrl,
  getLiveGps,
  runConcurrentUploads,
  type SessionPhoto,
  uploadSessionPhoto,
} from "@/lib/capture-upload";
import { Button, TextInput } from "@/components/ui";

type UploadState = Record<string, { status: "queued" | "uploading" | "complete" | "failed"; error?: string }>;

export function CapturePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialDealId = params.get("dealId");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [projects, setProjects] = useState<FieldProject[]>([]);
  const [starred, setStarred] = useState<FieldProject[]>([]);
  const [selectedDealId, setSelectedDealId] = useState(initialDealId ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [sessionPhotos, setSessionPhotos] = useState<SessionPhoto[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({});
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ projects: FieldProject[] }>("/field/projects?status=active&page=1&perPage=100"),
      api<{ projects: FieldProject[] }>("/field/projects/starred"),
    ]).then(([all, starredResult]) => {
      if (cancelled) return;
      setProjects(all.projects);
      setStarred(starredResult.projects);
      if (initialDealId && all.projects.some((project) => project.id === initialDealId)) setSelectedDealId(initialDealId);
    }).catch((err) => setError(err instanceof Error ? err.message : "Failed to load projects"));
    return () => { cancelled = true; };
  }, [initialDealId]);

  useEffect(() => {
    let cancelled = false;
    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setCameraError("Camera is not available in this browser.");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
      } catch {
        setCameraError("Camera access is blocked. Enable camera permission in your browser settings to capture photos.");
      }
    }
    void startCamera();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedDealId) ?? starred.find((project) => project.id === selectedDealId) ?? null;
  const projectResults = useMemo(() => {
    const merged = [...starred, ...projects.filter((project) => !starred.some((item) => item.id === project.id))];
    const search = projectSearch.trim().toLowerCase();
    return merged.filter((project) => !search || project.name.toLowerCase().includes(search) || (project.propertyAddress ?? "").toLowerCase().includes(search));
  }, [projectSearch, projects, starred]);

  async function addFiles(files: FileList | File[]) {
    const additions: SessionPhoto[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const [exifMetadata, liveGps, previewUrl] = await Promise.all([
        extractPhotoMetadata(file, "gallery"),
        getLiveGps(),
        fileToDataUrl(file),
      ]);
      additions.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        previewUrl,
        name: file.name,
        metadata: {
          ...liveGps,
          ...exifMetadata,
          takenAt: exifMetadata.takenAt ?? liveGps.takenAt ?? new Date().toISOString(),
        },
      });
    }
    setSessionPhotos((current) => [...current, ...additions]);
  }

  async function capturePhoto() {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return;
    const file = new File([blob], `capture-${new Date().toISOString()}.jpg`, { type: "image/jpeg" });
    const [gps, previewUrl] = await Promise.all([getLiveGps(), fileToDataUrl(file)]);
    setSessionPhotos((current) => [...current, {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      file,
      previewUrl,
      name: file.name,
      metadata: { ...gps, addressSource: gps.latitude !== undefined ? "live_gps" : undefined, takenAt: gps.takenAt ?? new Date().toISOString() },
    }]);
  }

  async function uploadPhotos(onlyFailed = false) {
    if (!selectedDealId) {
      setError("Choose a project before uploading.");
      return;
    }
    const photos = onlyFailed
      ? sessionPhotos.filter((photo) => uploadState[photo.id]?.status === "failed")
      : sessionPhotos;
    if (photos.length === 0) return;
    setUploading(true);
    setError(null);
    setUploadState((current) => ({
      ...current,
      ...Object.fromEntries(photos.map((photo) => [photo.id, { status: "queued" as const }])),
    }));
    const results = await runConcurrentUploads(photos, 3, async (photo) => {
      setUploadState((current) => ({ ...current, [photo.id]: { status: "uploading" } }));
      const result = await uploadSessionPhoto({ dealId: selectedDealId, file: photo.file, category, caption: null, metadata: photo.metadata });
      setUploadState((current) => ({ ...current, [photo.id]: { status: "complete" } }));
      return result;
    });
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const photo = photos[index];
        setUploadState((current) => ({ ...current, [photo.id]: { status: "failed", error: result.reason instanceof Error ? result.reason.message : "Upload failed" } }));
      }
    });
    setUploading(false);
    if (results.every((result) => result.status === "fulfilled")) {
      navigate(`/projects/${selectedDealId}`);
    }
  }

  const failedCount = Object.values(uploadState).filter((state) => state.status === "failed").length;
  const sessionLabel = `${sessionPhotos.length} ${sessionPhotos.length === 1 ? "photo" : "photos"} in this session`;

  return (
    <section className="relative -mx-4 -my-6 min-h-[calc(100vh-96px)] bg-slate-950 text-white">
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-4">
        <button type="button" aria-label={selectedProject ? "Change project" : "Choose project"} className="min-h-11 min-w-0 flex-1 rounded-full bg-white/15 px-4 text-left font-bold backdrop-blur" onClick={() => setPickerOpen(true)}>
          {selectedProject ? selectedProject.name : "Choose project"}
        </button>
        <button type="button" aria-label="Pick from gallery" className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/15" onClick={() => fileInputRef.current?.click()}>
          <ImagePlus className="h-5 w-5" />
        </button>
        <button type="button" aria-label="Close capture" className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/15" onClick={() => navigate(selectedDealId ? `/projects/${selectedDealId}` : "/projects")}>
          <X className="h-5 w-5" />
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple capture="environment" className="hidden" onChange={(event) => event.target.files && void addFiles(event.target.files)} />
      </div>

      <div className="flex min-h-[calc(100vh-96px)] items-center justify-center">
        {cameraError ? (
          <div className="mx-5 rounded-md bg-white p-5 text-slate-950">
            <h1 className="text-xl font-black">Camera access is blocked</h1>
            <p className="mt-2 text-sm font-semibold text-slate-600">{cameraError}</p>
            <Button className="mt-4 w-full" onClick={() => fileInputRef.current?.click()}>Use gallery instead</Button>
          </div>
        ) : (
          <video ref={videoRef} className="h-full min-h-[calc(100vh-96px)] w-full object-cover" playsInline muted aria-label="Camera preview" />
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 space-y-3 bg-gradient-to-t from-black/80 to-transparent p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {error ? <p className="rounded-md bg-red-500/90 p-2 text-sm font-bold">{error}</p> : null}
        {sessionPhotos.length > 0 ? <p className="text-center text-sm font-bold">{sessionLabel}</p> : null}
        <div className="flex gap-2 overflow-x-auto">
          <button type="button" aria-pressed={category === null} className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${category === null ? "bg-white text-slate-950" : "bg-white/15"}`} onClick={() => setCategory(null)}>No category</button>
          {PHOTO_CATEGORIES.map((item) => (
            <button key={item.value} type="button" aria-pressed={category === item.value} className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${category === item.value ? "bg-white text-slate-950" : "bg-white/15"}`} onClick={() => setCategory(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
        {sessionPhotos.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto">
            {sessionPhotos.map((photo) => (
              <div key={photo.id} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-white/15">
                <img src={photo.previewUrl} alt={photo.name} className="h-full w-full object-cover" />
                <button type="button" aria-label={`Remove ${photo.name}`} className="absolute right-0 top-0 rounded-bl-md bg-black/70 p-1" onClick={() => setSessionPhotos((current) => current.filter((item) => item.id !== photo.id))}>
                  <X className="h-4 w-4" />
                </button>
                {uploadState[photo.id]?.status === "complete" ? <Check className="absolute bottom-1 right-1 h-4 w-4 text-green-300" /> : null}
              </div>
            ))}
          </div>
        ) : null}
        {failedCount > 0 ? <p className="rounded-md bg-red-500/90 p-2 text-center text-sm font-bold">{Object.values(uploadState).find((state) => state.status === "failed")?.error}</p> : null}
        <div className="flex items-center justify-center gap-4">
          <button type="button" aria-label="Capture photo" disabled={!selectedDealId || Boolean(cameraError)} className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white text-slate-950 disabled:opacity-50" onClick={() => void capturePhoto()}>
            <Camera className="h-8 w-8" />
          </button>
          {sessionPhotos.length > 0 ? <Button disabled={uploading || !selectedDealId} onClick={() => void uploadPhotos(false)}>Upload</Button> : null}
          {failedCount > 0 ? <Button variant="danger" disabled={uploading} onClick={() => void uploadPhotos(true)}>Retry failed</Button> : null}
        </div>
      </div>

      {pickerOpen ? (
        <ProjectPicker
          projects={projectResults}
          search={projectSearch}
          onSearch={setProjectSearch}
          onSelect={(project) => {
            setSelectedDealId(project.id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </section>
  );
}

function ProjectPicker({ projects, search, onSearch, onSelect, onClose }: {
  projects: FieldProject[];
  search: string;
  onSearch: (value: string) => void;
  onSelect: (project: FieldProject) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 text-slate-950" role="dialog" aria-label="Choose project">
      <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-auto rounded-t-2xl bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-black">Choose project</h2>
          <button type="button" aria-label="Close project picker" onClick={onClose}><X /></button>
        </div>
        <label className="relative block">
          <Search className="absolute left-3 top-3 h-5 w-5 text-muted-foreground" />
          <TextInput aria-label="Search projects" className="pl-10" value={search} onInput={(event) => onSearch(event.currentTarget.value)} placeholder="Search project or address" />
        </label>
        <div className="mt-4 space-y-2">
          {projects.map((project) => (
            <button key={project.id} type="button" className="flex w-full items-center gap-3 rounded-md bg-muted p-3 text-left" onClick={() => onSelect(project)}>
              <FolderOpen className="h-5 w-5 text-primary" />
              <span className="min-w-0">
                <span className="block truncate font-black">{project.name}</span>
                <span className="block truncate text-sm text-muted-foreground">{project.propertyAddress ?? project.dealNumber}</span>
              </span>
            </button>
          ))}
          {projects.length === 0 ? <p className="p-5 text-center font-semibold text-muted-foreground">No projects match your search.</p> : null}
        </div>
      </div>
    </div>
  );
}
