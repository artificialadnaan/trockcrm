import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, Check, FolderOpen, ImagePlus, Search, X } from "lucide-react";
import { api } from "../lib/api";
import { groupCaptureTargets, PHOTO_CATEGORIES, type FieldCaptureTarget } from "../lib/field-projects";
import {
  extractPhotoMetadata,
  fileToDataUrl,
  getLiveGps,
  runConcurrentUploads,
  type SessionPhoto,
  uploadSessionPhoto,
} from "../lib/capture-upload";
import { Button, TextInput } from "../components/ui";

type UploadState = Record<string, { status: "queued" | "uploading" | "complete" | "failed"; error?: string }>;

function initialTargetFromParams(params: URLSearchParams): FieldCaptureTarget | null {
  const leadId = params.get("leadId");
  if (leadId) {
    return {
      id: leadId,
      type: "lead",
      name: params.get("targetName") ?? params.get("leadName") ?? "Selected lead",
      recordNumber: null,
      stageName: null,
      companyName: null,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  const opportunityId = params.get("opportunityId");
  if (opportunityId) {
    return {
      id: opportunityId,
      type: "opportunity",
      name: params.get("targetName") ?? params.get("opportunityName") ?? "Selected opportunity",
      recordNumber: null,
      stageName: null,
      companyName: null,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  const dealId = params.get("dealId");
  if (!dealId) return null;
  return {
    id: dealId,
    type: params.get("targetType") === "opportunity" ? "opportunity" : "deal",
    name: params.get("targetName") ?? params.get("dealName") ?? "Selected deal",
    recordNumber: null,
    stageName: null,
    companyName: null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function CapturePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialTarget = useMemo(() => initialTargetFromParams(params), [params]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [targetResults, setTargetResults] = useState<FieldCaptureTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<FieldCaptureTarget | null>(initialTarget);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [targetSearch, setTargetSearch] = useState(initialTarget?.name ?? "");
  const [category, setCategory] = useState<string | null>(null);
  const [sessionPhotos, setSessionPhotos] = useState<SessionPhoto[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({});
  const [error, setError] = useState<string | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ targets: FieldCaptureTarget[] }>(`/field/photo-targets/search?search=${encodeURIComponent(targetSearch)}&limit=30`)
        .then((result) => {
          if (!cancelled) setTargetResults(result.targets);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load capture targets");
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [targetSearch]);

  useEffect(() => {
    let cancelled = false;
    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setCameraError("Camera is not available in this browser.");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
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

  const groupedTargets = useMemo(() => groupCaptureTargets(targetResults), [targetResults]);

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
      metadata: {
        ...gps,
        addressSource: gps.latitude !== undefined ? "live_gps" : undefined,
        takenAt: gps.takenAt ?? new Date().toISOString(),
      },
    }]);
  }

  async function uploadPhotos(onlyFailed = false) {
    if (!selectedTarget) {
      setError("Choose a capture target before uploading.");
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
      const result = await uploadSessionPhoto({
        dealId: selectedTarget.type === "deal" ? selectedTarget.id : undefined,
        leadId: selectedTarget.type === "lead" ? selectedTarget.id : undefined,
        opportunityId: selectedTarget.type === "opportunity" ? selectedTarget.id : undefined,
        file: photo.file,
        category,
        caption: null,
        metadata: photo.metadata,
      });
      setUploadState((current) => ({ ...current, [photo.id]: { status: "complete" } }));
      return result;
    });

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const photo = photos[index];
        setUploadState((current) => ({
          ...current,
          [photo.id]: {
            status: "failed",
            error: result.reason instanceof Error ? result.reason.message : "Upload failed",
          },
        }));
      }
    });

    setUploading(false);
    if (results.every((result) => result.status === "fulfilled")) {
      if (selectedTarget.type === "deal" || selectedTarget.type === "opportunity") {
        navigate(`/projects/${selectedTarget.id}`);
      }
    }
  }

  const failedCount = Object.values(uploadState).filter((state) => state.status === "failed").length;
  const canCapture = Boolean(selectedTarget) && !cameraError;
  const sessionLabel = `${sessionPhotos.length} ${sessionPhotos.length === 1 ? "photo" : "photos"} in this session`;
  const targetCount = groupedTargets.lead.length + groupedTargets.opportunity.length + groupedTargets.deal.length;

  return (
    <section className="relative -mx-4 -my-6 min-h-[calc(100vh-96px)] bg-slate-950 text-white">
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-4">
        <button
          type="button"
          aria-label={selectedTarget ? "Change target" : "Choose target"}
          className="min-h-11 min-w-0 flex-1 rounded-full bg-white/15 px-4 text-left font-bold backdrop-blur"
          onClick={() => setPickerOpen(true)}
        >
          {selectedTarget ? selectedTarget.name : "Choose target"}
        </button>
        <button
          type="button"
          aria-label="Pick from gallery"
          className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-white/15 px-3 font-bold"
          onClick={() => galleryInputRef.current?.click()}
        >
          <ImagePlus className="h-5 w-5" />
          <span className="text-sm">Gallery</span>
        </button>
        <button
          type="button"
          aria-label="Close capture"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/15"
          onClick={() => navigate(selectedTarget && selectedTarget.type !== "lead" ? `/projects/${selectedTarget.id}` : "/projects")}
        >
          <X className="h-5 w-5" />
        </button>
        <input
          ref={galleryInputRef}
          aria-label="Gallery photo picker"
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => event.target.files && void addFiles(event.target.files)}
        />
      </div>

      <div className="flex min-h-[calc(100vh-96px)] items-center justify-center">
        {cameraError ? (
          <div className="mx-5 rounded-md bg-white p-5 text-slate-950">
            <h1 className="text-xl font-black">Camera access is blocked</h1>
            <p className="mt-2 text-sm font-semibold text-slate-600">{cameraError}</p>
            <Button className="mt-4 w-full" onClick={() => galleryInputRef.current?.click()}>
              Use gallery instead
            </Button>
          </div>
        ) : (
          <video ref={videoRef} className="h-full min-h-[calc(100vh-96px)] w-full object-cover" playsInline muted aria-label="Camera preview" />
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 space-y-3 bg-gradient-to-t from-black/80 to-transparent p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {error ? <p className="rounded-md bg-red-500/90 p-2 text-sm font-bold">{error}</p> : null}
        {sessionPhotos.length > 0 ? <p className="text-center text-sm font-bold">{sessionLabel}</p> : null}
        <div className="flex gap-2 overflow-x-auto">
          <button
            type="button"
            aria-pressed={category === null}
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${category === null ? "bg-white text-slate-950" : "bg-white/15"}`}
            onClick={() => setCategory(null)}
          >
            No category
          </button>
          {PHOTO_CATEGORIES.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={category === item.value}
              className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${category === item.value ? "bg-white text-slate-950" : "bg-white/15"}`}
              onClick={() => setCategory(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {sessionPhotos.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto">
            {sessionPhotos.map((photo) => (
              <div key={photo.id} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-white/15">
                <img src={photo.previewUrl} alt={photo.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label={`Remove ${photo.name}`}
                  className="absolute right-0 top-0 rounded-bl-md bg-black/70 p-1"
                  onClick={() => setSessionPhotos((current) => current.filter((item) => item.id !== photo.id))}
                >
                  <X className="h-4 w-4" />
                </button>
                {uploadState[photo.id]?.status === "complete" ? <Check className="absolute bottom-1 right-1 h-4 w-4 text-green-300" /> : null}
              </div>
            ))}
          </div>
        ) : null}
        {failedCount > 0 ? <p className="rounded-md bg-red-500/90 p-2 text-center text-sm font-bold">{Object.values(uploadState).find((state) => state.status === "failed")?.error}</p> : null}
        <div className="flex items-center justify-center gap-4">
          <button
            type="button"
            aria-label="Capture photo"
            disabled={!canCapture}
            className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white text-slate-950 disabled:opacity-50"
            onClick={() => void capturePhoto()}
          >
            <Camera className="h-8 w-8" />
          </button>
          {sessionPhotos.length > 0 ? <Button disabled={uploading || !selectedTarget} onClick={() => void uploadPhotos(false)}>Upload</Button> : null}
          {failedCount > 0 ? <Button variant="danger" disabled={uploading} onClick={() => void uploadPhotos(true)}>Retry failed</Button> : null}
        </div>
      </div>

      {pickerOpen ? (
        <TargetPicker
          groupedTargets={groupedTargets}
          search={targetSearch}
          onSearch={setTargetSearch}
          onSelect={(target) => {
            setSelectedTarget(target);
            setTargetSearch(target.name);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
          hasResults={targetCount > 0}
        />
      ) : null}
    </section>
  );
}

function TargetPicker(input: {
  groupedTargets: ReturnType<typeof groupCaptureTargets>;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (target: FieldCaptureTarget) => void;
  onClose: () => void;
  hasResults: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 text-slate-950" role="dialog" aria-label="Choose target">
      <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-auto rounded-t-2xl bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-black">Choose target</h2>
          <button type="button" aria-label="Close target picker" onClick={input.onClose}><X /></button>
        </div>
        <label className="relative block">
          <Search className="absolute left-3 top-3 h-5 w-5 text-muted-foreground" />
          <TextInput
            aria-label="Search targets"
            className="pl-10"
            value={input.search}
            onInput={(event) => input.onSearch(event.currentTarget.value)}
            placeholder="Search lead, opportunity, or deal"
          />
        </label>
        <div className="mt-4 space-y-3">
          {(["lead", "opportunity", "deal"] as const).map((kind) => {
            const targets = input.groupedTargets[kind];
            if (targets.length === 0) return null;
            const label = kind === "lead" ? "Leads" : kind === "opportunity" ? "Opportunities" : "Deals";
            return (
              <div key={kind} className="space-y-2">
                <p className="px-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
                {targets.map((target) => (
                  <button
                    key={`${target.type}-${target.id}`}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-md bg-muted p-3 text-left"
                    onClick={() => input.onSelect(target)}
                  >
                    <FolderOpen className="h-5 w-5 text-primary" />
                    <span className="min-w-0">
                      <span className="block truncate font-black">{target.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {target.recordNumber ? `${target.recordNumber} · ` : ""}
                        {target.stageName ?? "No stage"}
                        {target.companyName ? ` · ${target.companyName}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {!input.hasResults ? <p className="p-5 text-center font-semibold text-muted-foreground">No targets match your search.</p> : null}
        </div>
      </div>
    </div>
  );
}
