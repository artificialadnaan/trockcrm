import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, Check, FolderOpen, ImagePlus, Search, X } from "lucide-react";
import { api } from "../lib/api";
import { groupCaptureTargets, PHOTO_CATEGORIES, type FieldCaptureTarget, type FieldPhoto } from "../lib/field-projects";
import {
  extractPhotoMetadata,
  fileToDataUrl,
  getLiveGps,
  runConcurrentUploads,
  type SessionPhoto,
  uploadSessionPhoto,
} from "../lib/capture-upload";
import { Button, TextInput } from "../components/ui";
import { VoiceRecorder } from "../components/VoiceRecorder";
import { PhotoTagInput } from "../components/PhotoTagInput";
import { getVoiceTranscriptionConfig } from "../lib/photo-dictation";

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

function validationQueryForTarget(target: FieldCaptureTarget): string {
  const params = new URLSearchParams();
  if (target.type === "lead") {
    params.set("leadId", target.id);
  } else if (target.type === "opportunity") {
    params.set("opportunityId", target.id);
  } else {
    params.set("dealId", target.id);
  }
  return params.toString();
}

export function CapturePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialTarget = useMemo(() => initialTargetFromParams(params), [params]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [targetResults, setTargetResults] = useState<FieldCaptureTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<FieldCaptureTarget | null>(null);
  const [validatingInitialTarget, setValidatingInitialTarget] = useState(Boolean(initialTarget));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [targetSearch, setTargetSearch] = useState(initialTarget?.name ?? "");
  const [category, setCategory] = useState<string | null>(null);
  const [sessionPhotos, setSessionPhotos] = useState<SessionPhoto[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({});
  const [error, setError] = useState<string | null>(null);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [voiceUnavailableHint, setVoiceUnavailableHint] = useState<string | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<FieldPhoto[]>([]);
  const [assigningPendingPhotoId, setAssigningPendingPhotoId] = useState<string | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  async function refreshPendingPhotos() {
    const result = await api<{ photos: FieldPhoto[] }>("/field/photos/pending");
    setPendingPhotos(result.photos);
    return result.photos;
  }

  useEffect(() => {
    if (!initialTarget) {
      setValidatingInitialTarget(false);
      setSelectedTarget(null);
      return;
    }

    let cancelled = false;
    setValidatingInitialTarget(true);
    setSelectedTarget(null);
    api<{ target: { id: string; type: FieldCaptureTarget["type"] } }>(
      `/field/photo-targets/validate?${validationQueryForTarget(initialTarget)}`
    )
      .then((result) => {
        if (cancelled) return;
        if (result.target.id !== initialTarget.id || result.target.type !== initialTarget.type) {
          throw new Error("Capture target validation mismatch");
        }
        setSelectedTarget(initialTarget);
        setTargetSearch(initialTarget.name);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to validate capture target");
          setPickerOpen(true);
        }
      })
      .finally(() => {
        if (!cancelled) setValidatingInitialTarget(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialTarget]);

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
    getVoiceTranscriptionConfig()
      .then((result) => {
        if (!cancelled) {
          setVoiceConfigured(Boolean(result.configured));
          setVoiceUnavailableHint(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVoiceConfigured(false);
          setVoiceUnavailableHint("Voice dictation is temporarily unavailable.");
        }
      });

    refreshPendingPhotos().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load pending captures");
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
        setCameraReady(true);
      } catch {
        setCameraError("Camera access is blocked. Enable camera permission in your browser settings to capture photos.");
        setCameraReady(false);
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
        description: "",
        tags: [],
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
      description: "",
      tags: [],
      metadata: {
        ...gps,
        addressSource: gps.latitude !== undefined ? "live_gps" : undefined,
        takenAt: gps.takenAt ?? new Date().toISOString(),
      },
    }]);
  }

  async function uploadPhotos(onlyFailed = false) {
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
        dealId: activeTarget?.type === "deal" ? activeTarget.id : undefined,
        leadId: activeTarget?.type === "lead" ? activeTarget.id : undefined,
        opportunityId: activeTarget?.type === "opportunity" ? activeTarget.id : undefined,
        file: photo.file,
        category,
        caption: photo.description || null,
        tags: photo.tags,
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
      if (!activeTarget) {
        const uploadedPendingPhotos = results
          .filter((result): result is PromiseFulfilledResult<{ photo: FieldPhoto }> => result.status === "fulfilled")
          .map((result) => result.value.photo)
          .filter((photo): photo is FieldPhoto => Boolean(photo?.id));
        setPendingPhotos((current) => [...uploadedPendingPhotos, ...current.filter((photo) => !uploadedPendingPhotos.some((uploaded) => uploaded.id === photo.id))]);
        setSessionPhotos([]);
        setUploadState({});
        refreshPendingPhotos().catch((err) => {
          setError(err instanceof Error ? err.message : "Saved to pending, but the list did not refresh.");
        });
        return;
      }
      setSessionPhotos([]);
      setUploadState({});
      if (activeTarget.type === "lead") {
        // The field app does not have a lead detail route yet, so return to the target list.
        navigate("/projects");
      } else {
        navigate(`/projects/${activeTarget.id}`);
      }
    }
  }

  async function assignPendingPhotoTarget(target: FieldCaptureTarget) {
    if (!assigningPendingPhotoId) {
      setSelectedTarget(target);
      setTargetSearch(target.name);
      setPickerOpen(false);
      return;
    }

    try {
      await api(`/field/photos/${assigningPendingPhotoId}/assign-target`, {
        method: "POST",
        json: {
          dealId: target.type === "deal" ? target.id : undefined,
          leadId: target.type === "lead" ? target.id : undefined,
          opportunityId: target.type === "opportunity" ? target.id : undefined,
        },
      });
      setPendingPhotos((current) => current.filter((photo) => photo.id !== assigningPendingPhotoId));
      setAssigningPendingPhotoId(null);
      setSelectedTarget(target);
      setTargetSearch(target.name);
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign pending capture");
    }
  }

  const failedCount = Object.values(uploadState).filter((state) => state.status === "failed").length;
  const canCapture = cameraReady && !cameraError;
  const sessionLabel = `${sessionPhotos.length} ${sessionPhotos.length === 1 ? "photo" : "photos"} in this session`;
  const targetCount = groupedTargets.lead.length + groupedTargets.opportunity.length + groupedTargets.deal.length;
  const activeTarget = selectedTarget ?? (validatingInitialTarget ? initialTarget : null);
  const updateSessionPhoto = (photoId: string, updater: (photo: SessionPhoto) => SessionPhoto) => {
    setSessionPhotos((current) => current.map((photo) => (photo.id === photoId ? updater(photo) : photo)));
  };
  const tagProjectId = activeTarget?.type === "lead" ? undefined : activeTarget?.id;
  const uploadActionLabel = activeTarget ? "Upload" : "Save to pending";

  return (
    <section className="relative -mx-4 -my-6 min-h-[calc(100vh-96px)] bg-slate-950 text-white">
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-4">
        <button
          type="button"
          aria-label={activeTarget ? "Change target" : "Choose target"}
          className="min-h-11 min-w-0 flex-1 rounded-full bg-white/15 px-4 text-left font-bold backdrop-blur"
          onClick={() => setPickerOpen(true)}
        >
          {validatingInitialTarget ? "Validating target..." : activeTarget ? activeTarget.name : "Choose target"}
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
          onClick={() => navigate(activeTarget && activeTarget.type !== "lead" ? `/projects/${activeTarget.id}` : "/projects")}
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
        {!activeTarget && !cameraError ? (
          <div className="rounded-xl bg-white/12 p-3 text-sm font-semibold text-white/90 backdrop-blur">
            No target selected yet. Capture or import now and this session will land in <span className="font-black">Pending captures</span> until you assign a project, lead, or opportunity.
          </div>
        ) : null}
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
          <div className="space-y-3">
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
            <div className="max-h-72 space-y-3 overflow-y-auto rounded-xl bg-black/25 p-3">
              {sessionPhotos.map((photo, index) => (
                <div key={photo.id} className="rounded-xl bg-white/10 p-3 backdrop-blur">
                  <div className="flex gap-3">
                    <img src={photo.previewUrl} alt={photo.name} className="h-20 w-20 rounded-md object-cover" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <p className="text-sm font-black">Photo {index + 1}</p>
                        <p className="truncate text-xs font-semibold text-white/70">{photo.name}</p>
                      </div>
                      <textarea
                        aria-label={`Photo ${index + 1} description`}
                        className="min-h-20 w-full rounded-md border border-white/10 bg-white px-3 py-2 text-sm text-slate-950 outline-none ring-primary/25 focus:ring-4"
                        placeholder={voiceConfigured ? "Add an optional description or use voice dictation" : "Add an optional description"}
                        value={photo.description}
                        onInput={(event) => updateSessionPhoto(photo.id, (current) => ({ ...current, description: (event.target as HTMLTextAreaElement).value }))}
                      />
                      {voiceConfigured ? (
                        <VoiceRecorder
                          disabled={uploading}
                          onTranscript={(transcript) => updateSessionPhoto(photo.id, (current) => ({
                            ...current,
                            description: current.description
                              ? `${current.description.trim()} ${transcript}`.trim()
                              : transcript,
                          }))}
                        />
                      ) : voiceUnavailableHint ? (
                        <p className="text-xs font-semibold text-white/70">{voiceUnavailableHint}</p>
                      ) : null}
                      <PhotoTagInput
                        projectId={tagProjectId}
                        disabled={uploading}
                        value={photo.tags}
                        onChange={(tags) => updateSessionPhoto(photo.id, (current) => ({ ...current, tags }))}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
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
          {sessionPhotos.length > 0 ? <Button disabled={uploading} onClick={() => void uploadPhotos(false)}>{uploadActionLabel}</Button> : null}
          {failedCount > 0 ? <Button variant="danger" disabled={uploading} onClick={() => void uploadPhotos(true)}>Retry failed</Button> : null}
        </div>
        {pendingPhotos.length > 0 ? (
          <div className="space-y-3 rounded-2xl bg-black/30 p-3 backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-black">Pending captures</p>
                <p className="text-xs font-semibold text-white/70">Assign these when you know the right target.</p>
              </div>
              <button
                type="button"
                className="rounded-full bg-white/15 px-3 py-2 text-xs font-black"
                onClick={() => setPickerOpen(true)}
              >
                Choose target
              </button>
            </div>
            <div className="flex gap-3 overflow-x-auto">
              {pendingPhotos.map((photo) => (
                <div key={photo.id} className="w-36 shrink-0 rounded-2xl bg-white/10 p-2">
                  <div className="h-24 overflow-hidden rounded-xl bg-white/10">
                    {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.displayName} className="h-full w-full object-cover" /> : null}
                  </div>
                  <p className="mt-2 truncate text-xs font-black">{photo.displayName}</p>
                  <button
                    type="button"
                    className="mt-2 w-full rounded-full bg-white px-3 py-2 text-xs font-black text-slate-950"
                    onClick={() => {
                      setAssigningPendingPhotoId(photo.id);
                      setPickerOpen(true);
                    }}
                  >
                    Assign target
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {pickerOpen ? (
        <TargetPicker
          groupedTargets={groupedTargets}
          search={targetSearch}
          onSearch={setTargetSearch}
          onSelect={(target) => { void assignPendingPhotoTarget(target); }}
          onClose={() => {
            setPickerOpen(false);
            setAssigningPendingPhotoId(null);
          }}
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
