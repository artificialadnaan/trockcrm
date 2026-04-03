import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Camera,
  MapPin,
  CheckCircle,
  ArrowLeft,
  Upload,
  X,
  Loader2,
  ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNearbyDeals } from "@/hooks/use-nearby-deals";
import { uploadFile } from "@/hooks/use-files";

// ─── Constants ──────────────────────────────────────────────────────────────

const SUBCATEGORIES = [
  "Progress",
  "Site Visit",
  "Damage",
  "Safety",
  "Delivery",
  "Other",
] as const;

type Subcategory = (typeof SUBCATEGORIES)[number];

// ─── Component ──────────────────────────────────────────────────────────────

export function PhotoCapturePage() {
  const { deals, autoSelectedDeal, gpsError, loading: gpsLoading } = useNearbyDeals();

  // State
  const [selectedDealId, setSelectedDealId] = useState<string>("");
  const [selectedSubcategory, setSelectedSubcategory] = useState<Subcategory | null>(null);
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recentCount, setRecentCount] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-select nearest deal
  useEffect(() => {
    if (autoSelectedDeal && !selectedDealId) {
      setSelectedDealId(autoSelectedDeal.id);
    }
  }, [autoSelectedDeal, selectedDealId]);

  // Clean up preview URL on unmount or change
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Auto-reset after successful upload
  useEffect(() => {
    if (!uploadSuccess) return;
    const timer = setTimeout(() => {
      setUploadSuccess(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [uploadSuccess]);

  // ─── Handlers ───────────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCapturedFile(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setUploadError(null);
    // Reset file input so the same file can be re-selected
    e.target.value = "";
  }

  function handleRetake() {
    setCapturedFile(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setNote("");
    setUploadError(null);
    setUploadProgress(0);
  }

  async function handleUpload() {
    if (!capturedFile || !selectedDealId) return;

    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);

    try {
      await uploadFile({
        file: capturedFile,
        category: "photo",
        subcategory: selectedSubcategory?.toLowerCase() || undefined,
        dealId: selectedDealId,
        description: note || undefined,
        tags: ["field-capture"],
        onProgress: (pct) => setUploadProgress(pct),
      });

      setRecentCount((c) => c + 1);
      setUploadSuccess(true);
      // Reset for next photo
      setCapturedFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setNote("");
      setUploadProgress(0);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function toggleSubcategory(sub: Subcategory) {
    setSelectedSubcategory((prev) => (prev === sub ? null : sub));
  }

  // ─── Derived ────────────────────────────────────────────────────────────

  const sortedDeals = deals.length > 0
    ? deals
    : [];

  const canUpload = !!capturedFile && !!selectedDealId && !uploading;

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 flex flex-col bg-[#111] text-white">
      {/* ── Top Bar ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to App
        </Link>
        <h1 className="text-base font-semibold tracking-tight">T Rock Photos</h1>
        <div className="w-[88px]" /> {/* Spacer to center title */}
      </header>

      {/* ── Scrollable Content ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-4 py-4 space-y-5">

          {/* ── Project Selector ──────────────────────────────────────── */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-white/50 uppercase tracking-wider">
              Project
            </label>

            {/* GPS Status */}
            <div className="flex items-center gap-2 text-xs text-white/40">
              {gpsLoading ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Detecting location...</span>
                </>
              ) : gpsError ? (
                <>
                  <MapPin className="h-3 w-3 text-amber-400" />
                  <span className="text-amber-400">GPS unavailable — showing all projects</span>
                </>
              ) : deals.length > 0 ? (
                <>
                  <MapPin className="h-3 w-3 text-emerald-400" />
                  <span className="text-emerald-400">
                    Sorted by distance
                    {autoSelectedDeal && " — nearest auto-selected"}
                  </span>
                </>
              ) : (
                <>
                  <MapPin className="h-3 w-3" />
                  <span>No nearby projects found</span>
                </>
              )}
            </div>

            <select
              value={selectedDealId}
              onChange={(e) => setSelectedDealId(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-3 text-sm text-white appearance-none focus:outline-none focus:ring-2 focus:ring-[#CC0000]/50 focus:border-[#CC0000]"
            >
              <option value="" className="bg-[#222] text-white">
                Select a project...
              </option>
              {sortedDeals.map((deal) => (
                <option key={deal.id} value={deal.id} className="bg-[#222] text-white">
                  {deal.name}
                  {deal.distance != null ? ` — ${deal.distance.toFixed(1)} mi` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* ── Subcategory Quick Tags ────────────────────────────────── */}
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

          {/* ── Camera / Preview Area ─────────────────────────────────── */}
          <div className="space-y-3">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className="hidden"
            />

            {uploadSuccess ? (
              /* ── Success State ────────────────────────────────────── */
              <div className="flex flex-col items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10 py-16">
                <CheckCircle className="h-16 w-16 text-emerald-400 mb-3" />
                <p className="text-lg font-semibold text-emerald-300">Photo saved!</p>
                <p className="text-sm text-white/40 mt-1">
                  {recentCount} photo{recentCount !== 1 ? "s" : ""} this session
                </p>
              </div>
            ) : capturedFile && previewUrl ? (
              /* ── Preview State ────────────────────────────────────── */
              <div className="space-y-3">
                <div className="relative rounded-2xl overflow-hidden border border-white/10">
                  <img
                    src={previewUrl}
                    alt="Captured photo preview"
                    className="w-full max-h-[50vh] object-contain bg-black"
                  />
                  <button
                    type="button"
                    onClick={handleRetake}
                    className="absolute top-2 right-2 rounded-full bg-black/60 p-2 text-white/80 hover:text-white transition-colors"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {/* Note Input */}
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a note (optional)"
                  className="bg-white/5 border-white/20 text-white placeholder:text-white/30 focus-visible:ring-[#CC0000]/50"
                />

                {/* Upload Progress */}
                {uploading && (
                  <div className="w-full rounded-full bg-white/10 h-2 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#CC0000] to-[#FF4444] transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                )}

                {/* Upload Error */}
                {uploadError && (
                  <p className="text-sm text-red-400 text-center">{uploadError}</p>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={handleRetake}
                    disabled={uploading}
                    className="flex-1 border-white/20 text-white hover:bg-white/10 hover:text-white"
                  >
                    Retake
                  </Button>
                  <Button
                    onClick={handleUpload}
                    disabled={!canUpload}
                    className="flex-1 bg-gradient-to-r from-[#CC0000] to-[#B00000] hover:from-[#DD1111] hover:to-[#CC0000] text-white font-semibold"
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        Upload
                      </>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              /* ── Camera Button State ─────────────────────────────── */
              <div className="flex flex-col items-center justify-center py-8">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!selectedDealId}
                  className={`relative flex items-center justify-center rounded-full h-28 w-28 transition-all ${
                    selectedDealId
                      ? "bg-gradient-to-br from-[#CC0000] to-[#880000] shadow-lg shadow-[#CC0000]/25 active:scale-95"
                      : "bg-white/10 cursor-not-allowed"
                  }`}
                >
                  <Camera
                    className={`h-12 w-12 ${
                      selectedDealId ? "text-white" : "text-white/30"
                    }`}
                  />
                </button>
                <p className="text-sm text-white/40 mt-4">
                  {!selectedDealId
                    ? "Select a project to start"
                    : "Tap to take a photo"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Sticky Bottom Bar ────────────────────────────────────────── */}
      <footer className="border-t border-white/10 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-white/40">
            <ImageIcon className="h-4 w-4" />
            <span>
              {recentCount} photo{recentCount !== 1 ? "s" : ""} this session
            </span>
          </div>
          {selectedDealId && (
            <p className="text-xs text-white/30 truncate max-w-[180px]">
              {sortedDeals.find((d) => d.id === selectedDealId)?.name}
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}
