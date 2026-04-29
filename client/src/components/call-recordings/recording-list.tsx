import { useCallback, useEffect, useState } from "react";
import { Play, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
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
  const [recordings, setRecordings] = useState<CallRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (user?.role === "construction") return;
    setLoading(true);
    try {
      const result = await api<{ recordings: CallRecording[] }>(
        `/call-recordings?entityType=${entityType}&entityId=${entityId}`
      );
      setRecordings(result.recordings);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load call recordings");
    } finally {
      setLoading(false);
    }
  }, [entityId, entityType, user?.role]);

  useEffect(() => {
    if (user?.role === "construction") return;
    void load();
  }, [load, user?.role]);

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

  if (user?.role === "construction") return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Call Recordings</h3>
          <p className="text-xs text-muted-foreground">Playback-only audio linked to this record.</p>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Upload Recording
          </Button>
        )}
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
