import { useState, useRef, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Camera,
  CheckCircle,
  ArrowLeft,
  Upload,
  X,
  Loader2,
  ImageIcon,
  Plus,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchPhotoUploadTargets, uploadFile, type PhotoUploadTarget } from "@/hooks/use-files";

const SUBCATEGORIES = [
  "Progress",
  "Site Visit",
  "Damage",
  "Safety",
  "Delivery",
  "Other",
] as const;

type Subcategory = (typeof SUBCATEGORIES)[number];

interface QueuedPhoto {
  id: string;
  file: File;
  previewUrl: string;
  note: string;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
  progress: number;
}

export function groupPhotoUploadTargets(targets: PhotoUploadTarget[]) {
  return {
    lead: targets.filter((target) => target.type === "lead"),
    opportunity: targets.filter((target) => target.type === "opportunity"),
    deal: targets.filter((target) => target.type === "deal"),
  };
}

export function PhotoCapturePage() {
  const [targetSearch, setTargetSearch] = useState("");
  const [targetResults, setTargetResults] = useState<PhotoUploadTarget[]>([]);
  const [targetLoading, setTargetLoading] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<PhotoUploadTarget | null>(null);
  const [selectedSubcategory, setSelectedSubcategory] = useState<Subcategory | null>(null);
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadComplete, setUploadComplete] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setTargetLoading(true);
    const timer = setTimeout(() => {
      searchPhotoUploadTargets(targetSearch, 30)
        .then((targets) => {
          if (!cancelled) setTargetResults(targets);
        })
        .catch((err) => {
          console.error("Failed to search photo targets:", err);
          if (!cancelled) setTargetResults([]);
        })
        .finally(() => {
          if (!cancelled) setTargetLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [targetSearch]);

  // Clean up all tracked blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  // Auto-reset success state
  useEffect(() => {
    if (!uploadComplete) return;
    const timer = setTimeout(() => setUploadComplete(false), 3000);
    return () => clearTimeout(timer);
  }, [uploadComplete]);

  // ─── Handlers ─────────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newPhotos: QueuedPhoto[] = Array.from(files).map((file) => {
      const newUrl = URL.createObjectURL(file);
      blobUrlsRef.current.push(newUrl);
      return {
        id: crypto.randomUUID(),
        file,
        previewUrl: newUrl,
        note: "",
        status: "pending" as const,
        progress: 0,
      };
    });

    setQueue((prev) => [...prev, ...newPhotos]);
    setUploadComplete(false);
    // Reset input so same file can be re-selected
    e.target.value = "";
  }

  function removePhoto(id: string) {
    setQueue((prev) => {
      const photo = prev.find((p) => p.id === id);
      if (photo) URL.revokeObjectURL(photo.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function updateNote(id: string, note: string) {
    setQueue((prev) => prev.map((p) => (p.id === id ? { ...p, note } : p)));
  }

  async function handleUploadAll() {
    if (!selectedTarget || queue.length === 0) return;

    setUploading(true);
    const pending = queue.filter((p) => p.status === "pending" || p.status === "error");
    let successCount = 0;

    for (const photo of pending) {
      // Mark as uploading
      setQueue((prev) =>
        prev.map((p) => (p.id === photo.id ? { ...p, status: "uploading", progress: 0, error: undefined } : p))
      );

      try {
        await uploadFile({
          file: photo.file,
          category: "photo",
          subcategory: selectedSubcategory?.toLowerCase() || undefined,
          dealId: selectedTarget.type === "lead" ? undefined : selectedTarget.id,
          leadId: selectedTarget.type === "lead" ? selectedTarget.id : undefined,
          description: photo.note || undefined,
          tags: ["field-capture"],
          onProgress: (pct) => {
            setQueue((prev) =>
              prev.map((p) => (p.id === photo.id ? { ...p, progress: pct } : p))
            );
          },
        });

        setQueue((prev) =>
          prev.map((p) => (p.id === photo.id ? { ...p, status: "done", progress: 100 } : p))
        );
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setQueue((prev) =>
          prev.map((p) => (p.id === photo.id ? { ...p, status: "error", error: msg } : p))
        );
      }
    }

    setUploading(false);
    setSessionCount((c) => c + successCount);

    // Clear completed photos from queue after a brief delay
    if (successCount > 0) {
      setUploadComplete(true);
      setTimeout(() => {
        setQueue((prev) => {
          prev.filter((p) => p.status === "done").forEach((p) => URL.revokeObjectURL(p.previewUrl));
          return prev.filter((p) => p.status !== "done");
        });
      }, 1500);
    }
  }

  function toggleSubcategory(sub: Subcategory) {
    setSelectedSubcategory((prev) => (prev === sub ? null : sub));
  }

  // ─── Derived ──────────────────────────────────────────────────────────

  const pendingCount = queue.filter((p) => p.status === "pending" || p.status === "error").length;
  const canUpload = pendingCount > 0 && !!selectedTarget && !uploading;
  const groupedTargets = useMemo(
    () => groupPhotoUploadTargets(targetResults),
    [targetResults]
  );

  return (
    <div className="fixed inset-0 flex flex-col bg-[#111] text-white">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-base font-semibold tracking-tight">T Rock Photos</h1>
        <div className="w-16" />
      </header>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-4 py-4 space-y-5">

          {/* Project Selector */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-white/50 uppercase tracking-wider">
              Project
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <Input
                value={targetSearch}
                onChange={(event) => setTargetSearch(event.target.value)}
                placeholder="Search leads, opportunities, and deals"
                className="h-11 border-white/20 bg-white/5 pl-9 text-white placeholder:text-white/30 focus-visible:ring-[#CC0000]/50"
              />
            </div>
            {selectedTarget ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-emerald-100">{selectedTarget.name}</p>
                    <p className="mt-0.5 truncate text-xs text-emerald-200/70">
                      {selectedTarget.recordNumber ? `${selectedTarget.recordNumber} · ` : ""}
                      {selectedTarget.stageName ?? "No stage"}
                      {selectedTarget.companyName ? ` · ${selectedTarget.companyName}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedTarget(null)}
                    className="shrink-0 rounded-full p-1 text-emerald-100/70 hover:bg-white/10 hover:text-white"
                    aria-label="Clear selected project"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03]">
                {targetLoading ? (
                  <div className="flex items-center gap-2 px-3 py-4 text-sm text-white/50">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Searching
                  </div>
                ) : targetResults.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-white/50">No matching records</p>
                ) : (
                  ([
                    ["lead", "Leads", groupedTargets.lead],
                    ["opportunity", "Opportunities", groupedTargets.opportunity],
                    ["deal", "Deals", groupedTargets.deal],
                  ] as const).map(([, label, targets]) =>
                    targets.length > 0 ? (
                      <div key={label} className="border-b border-white/10 last:border-b-0">
                        <p className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-widest text-white/40">
                          {label}
                        </p>
                        {targets.map((target) => (
                          <button
                            key={`${target.type}-${target.id}`}
                            type="button"
                            onClick={() => {
                              setSelectedTarget(target);
                              setTargetSearch(target.name);
                            }}
                            className="w-full px-3 py-2 text-left transition-colors hover:bg-white/10"
                          >
                            <p className="truncate text-sm font-medium text-white">{target.name}</p>
                            <p className="mt-0.5 truncate text-xs text-white/45">
                              {target.recordNumber ? `${target.recordNumber} · ` : ""}
                              {target.stageName ?? "No stage"}
                              {target.companyName ? ` · ${target.companyName}` : ""}
                              {" · "}
                              {new Date(target.lastUpdatedAt).toLocaleDateString()}
                            </p>
                          </button>
                        ))}
                      </div>
                    ) : null
                  )
                )}
              </div>
            )}
          </div>

          {/* Subcategory Quick Tags */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-white/50 uppercase tracking-wider">
              Category
            </label>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 scrollbar-hide">
              {SUBCATEGORIES.map((sub) => (
                <button
                  key={sub}
                  type="button"
                  onClick={() => toggleSubcategory(sub)}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                    selectedSubcategory === sub
                      ? "bg-[#CC0000] text-white"
                      : "bg-white/10 text-white/70 hover:bg-white/20"
                  }`}
                >
                  {sub}
                </button>
              ))}
            </div>
          </div>

          {/* Camera Button — always visible to add more photos */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />

          <div className="flex flex-col items-center py-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!selectedTarget}
              className={`relative flex items-center justify-center rounded-full h-24 w-24 transition-all ${
                selectedTarget
                  ? "bg-gradient-to-br from-[#CC0000] to-[#880000] shadow-lg shadow-[#CC0000]/25 active:scale-95"
                  : "bg-white/10 cursor-not-allowed"
              }`}
            >
              {queue.length > 0 ? (
                <Plus className={`h-10 w-10 ${selectedTarget ? "text-white" : "text-white/30"}`} />
              ) : (
                <Camera className={`h-10 w-10 ${selectedTarget ? "text-white" : "text-white/30"}`} />
              )}
            </button>
            <p className="text-sm text-white/40 mt-3">
              {!selectedTarget
                ? "Select a project to start"
                : queue.length > 0
                ? "Tap to add more photos"
                : "Tap to take a photo"}
            </p>
          </div>

          {/* Upload Complete Banner */}
          {uploadComplete && (
            <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 py-3">
              <CheckCircle className="h-5 w-5 text-emerald-400" />
              <span className="text-sm font-semibold text-emerald-300">Photos uploaded!</span>
            </div>
          )}

          {/* Photo Queue */}
          {queue.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-white/50 uppercase tracking-wider">
                  {queue.length} Photo{queue.length !== 1 ? "s" : ""} Ready
                </label>
                {pendingCount > 0 && !uploading && (
                  <button
                    onClick={() => {
                      queue.forEach((p) => URL.revokeObjectURL(p.previewUrl));
                      setQueue([]);
                    }}
                    className="text-xs text-white/40 hover:text-red-400 transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                {queue.map((photo) => (
                  <div
                    key={photo.id}
                    className={`relative rounded-xl overflow-hidden border ${
                      photo.status === "done"
                        ? "border-emerald-500/50"
                        : photo.status === "error"
                        ? "border-red-500/50"
                        : photo.status === "uploading"
                        ? "border-[#CC0000]/50"
                        : "border-white/10"
                    }`}
                  >
                    <img
                      src={photo.previewUrl}
                      alt="Queued photo"
                      className="w-full h-32 object-cover"
                    />

                    {/* Status overlay */}
                    {photo.status === "done" && (
                      <div className="absolute inset-0 bg-emerald-500/20 flex items-center justify-center">
                        <CheckCircle className="h-8 w-8 text-emerald-400" />
                      </div>
                    )}
                    {photo.status === "uploading" && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <Loader2 className="h-8 w-8 text-white animate-spin" />
                      </div>
                    )}
                    {photo.status === "error" && (
                      <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center">
                        <p className="text-xs text-red-300 px-2 text-center">{photo.error}</p>
                      </div>
                    )}

                    {/* Progress bar */}
                    {photo.status === "uploading" && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
                        <div
                          className="h-full bg-[#CC0000] transition-all"
                          style={{ width: `${photo.progress}%` }}
                        />
                      </div>
                    )}

                    {/* Remove button (only when pending) */}
                    {photo.status === "pending" && !uploading && (
                      <button
                        type="button"
                        onClick={() => removePhoto(photo.id)}
                        className="absolute top-1 right-1 rounded-full bg-black/60 p-1.5 text-white/70 hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Optional note for the batch */}
              {pendingCount > 0 && (
                <Input
                  value={queue[0]?.note ?? ""}
                  onChange={(e) => {
                    const note = e.target.value;
                    setQueue((prev) =>
                      prev.map((p) => (p.status === "pending" ? { ...p, note } : p))
                    );
                  }}
                  placeholder="Add a note for all photos (optional)"
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30 focus-visible:ring-[#CC0000]/50"
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sticky Bottom — Upload All Button */}
      <footer className="border-t border-white/10 px-4 py-3 flex-shrink-0">
        <div className="max-w-lg mx-auto space-y-2">
          {canUpload ? (
            <Button
              onClick={handleUploadAll}
              className="w-full bg-gradient-to-r from-[#CC0000] to-[#B00000] hover:from-[#DD1111] hover:to-[#CC0000] text-white font-bold py-6 text-base"
            >
              <Upload className="h-5 w-5 mr-2" />
              Upload {pendingCount} Photo{pendingCount !== 1 ? "s" : ""}
            </Button>
          ) : uploading ? (
            <Button disabled className="w-full py-6 text-base bg-white/10 text-white/50">
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Uploading...
            </Button>
          ) : (
            <div className="flex items-center justify-between text-sm text-white/40">
              <div className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4" />
                <span>{sessionCount} uploaded this session</span>
              </div>
              {selectedTarget && (
                <p className="text-xs text-white/30 truncate max-w-[180px]">
                  {selectedTarget.name}
                </p>
              )}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
