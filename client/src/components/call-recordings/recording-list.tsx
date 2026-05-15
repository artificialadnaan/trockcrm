import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Play, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canUploadCallRecordings, canViewCallRecordings } from "@trock-crm/shared/types";
import { UploadRecordingModal } from "./upload-modal";

type EntityType = "deal" | "lead" | "company" | "contact";

interface CallRecording {
  id: string;
  originalFilename: string;
  title: string | null;
  callDate: string | null;
  uploadedAt: string;
  uploadedByName: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number;
  transcriptionStatus: "none" | "pending" | "processing" | "complete" | "failed";
  transcriptionError: string | null;
  transcriptSummary: string | null;
}

interface Transcript {
  summary: string | null;
  fullText: string | null;
  status: CallRecording["transcriptionStatus"];
  error: string | null;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "Unknown duration";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatDate(value: string | null, fallback: string) {
  const date = new Date(value ?? fallback);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function RecordingList({
  entityType,
  entityId,
}: {
  entityType: EntityType;
  entityId: string;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canUseRecordings = canViewCallRecordings(user?.role);
  const canUpload = canUploadCallRecordings(user?.role);
  const [recordings, setRecordings] = useState<CallRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openTranscriptId, setOpenTranscriptId] = useState<string | null>(null);
  const [expandedTranscriptId, setExpandedTranscriptId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>({});
  const [transcriptLoadingId, setTranscriptLoadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canUseRecordings) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ entityType, entityId });
      if (search.trim()) params.set("search", search.trim());
      const result = await api<{ recordings: CallRecording[] }>(
        `/call-recordings?${params.toString()}`
      );
      setRecordings(result.recordings);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load call recordings");
    } finally {
      setLoading(false);
    }
  }, [canUseRecordings, entityId, entityType, search]);

  useEffect(() => {
    if (!canUseRecordings) return;
    void load();
  }, [canUseRecordings, load]);

  useEffect(() => {
    if (!recordings.some((recording) => ["pending", "processing"].includes(recording.transcriptionStatus))) {
      return;
    }
    const timer = window.setTimeout(() => void load(), 10000);
    return () => window.clearTimeout(timer);
  }, [load, recordings]);

  const play = async (recordingId: string) => {
    if (playingId === recordingId) {
      setPlayingId(null);
      setPlaybackUrl(null);
      return;
    }

    try {
      const result = await api<{ playbackUrl: string }>(`/call-recordings/${recordingId}/playback`);
      setPlayingId(recordingId);
      setPlaybackUrl(result.playbackUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to load playback URL");
    }
  };

  const remove = async (recording: CallRecording) => {
    if (!window.confirm(`Delete ${recording.title || recording.originalFilename}?`)) return;
    try {
      await api(`/call-recordings/${recording.id}`, { method: "DELETE" });
      toast.success("Call recording deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to delete call recording");
    }
  };

  const toggleTranscript = async (recording: CallRecording) => {
    if (openTranscriptId === recording.id) {
      setOpenTranscriptId(null);
      return;
    }
    setOpenTranscriptId(recording.id);
    setExpandedTranscriptId(null);
    if (transcripts[recording.id]) return;

    setTranscriptLoadingId(recording.id);
    try {
      const transcript = await api<Transcript>(`/call-recordings/${recording.id}/transcript`);
      setTranscripts((current) => ({ ...current, [recording.id]: transcript }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to load transcript");
    } finally {
      setTranscriptLoadingId(null);
    }
  };

  const renderStatus = (recording: CallRecording) => {
    if (recording.transcriptionStatus === "none") return null;
    if (recording.transcriptionStatus === "pending") {
      return <Badge variant="outline" className="text-muted-foreground">Transcription queued</Badge>;
    }
    if (recording.transcriptionStatus === "processing") {
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Transcribing...
        </Badge>
      );
    }
    if (recording.transcriptionStatus === "failed") {
      return (
        <Badge variant="destructive" title={recording.transcriptionError ?? "Transcription failed"}>
          <AlertCircle className="h-3 w-3" />
          Transcription failed
        </Badge>
      );
    }
    return (
      <button type="button" onClick={() => toggleTranscript(recording)} className="inline-flex">
        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
          <CheckCircle2 className="h-3 w-3" />
          Transcribed
        </Badge>
      </button>
    );
  };

  if (!canUseRecordings) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Call Recordings</h3>
          <p className="text-xs text-muted-foreground">Playback-only audio linked to this record.</p>
        </div>
        {canUpload && (
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Upload Recording
          </Button>
        )}
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search transcripts"
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="h-20 animate-pulse rounded-md bg-muted" />
      ) : recordings.length === 0 ? (
        <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
          No call recordings yet.
        </p>
      ) : (
        <div className="divide-y rounded-md border">
          {recordings.map((recording) => (
            <div key={recording.id} className="space-y-3 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{recording.title || recording.originalFilename}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDate(recording.callDate, recording.uploadedAt)} · {formatDuration(recording.durationSeconds)} · Uploaded by {recording.uploadedByName ?? "Unknown"}
                  </p>
                  <div className="mt-2">{renderStatus(recording)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => play(recording.id)}>
                    <Play className="mr-1.5 h-4 w-4" />
                    Play
                  </Button>
                  {isAdmin && (
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(recording)} aria-label="Delete recording">
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  )}
                </div>
              </div>
              {playingId === recording.id && playbackUrl && (
                <audio className="w-full" controls src={playbackUrl}>
                  <track kind="captions" />
                </audio>
              )}
              {openTranscriptId === recording.id && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  {transcriptLoadingId === recording.id ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading transcript...
                    </div>
                  ) : (
                    (() => {
                      const transcript = transcripts[recording.id];
                      const summary = transcript?.summary ?? recording.transcriptSummary;
                      const fullText = transcript?.fullText;
                      return (
                        <div className="space-y-3">
                          <div>
                            <p className="text-xs font-medium uppercase text-muted-foreground">Auto-summary</p>
                            <p className="mt-1 rounded-md bg-background p-3 leading-relaxed">
                              {summary || "No summary available."}
                            </p>
                          </div>
                          {fullText && (
                            <div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setExpandedTranscriptId(
                                  expandedTranscriptId === recording.id ? null : recording.id
                                )}
                              >
                                {expandedTranscriptId === recording.id ? "Hide full transcript" : "Show full transcript"}
                              </Button>
                              {expandedTranscriptId === recording.id && (
                                <div className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md bg-background p-3 text-sm leading-relaxed">
                                  {fullText}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <UploadRecordingModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        entityType={entityType}
        entityId={entityId}
        onUploaded={load}
      />
    </section>
  );
}
