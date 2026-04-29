import { useRef, useState, type FormEvent } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

type EntityType = "deal" | "lead" | "company" | "contact";

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
]);

function getAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration) : null);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    audio.src = url;
  });
}

function putFile(uploadUrl: string, file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network failure while uploading the recording."));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Try again from a stronger connection."));
    xhr.send(file);
  });
}

export function UploadRecordingModal({
  open,
  onOpenChange,
  entityType,
  entityId,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: EntityType;
  entityId: string;
  onUploaded: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState("");
  const [callDate, setCallDate] = useState("");
  const [notes, setNotes] = useState("");
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setCallDate("");
    setNotes("");
    setProgress(0);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose an audio file to upload.");
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      setError("Call recordings must be 200 MB or smaller.");
      return;
    }
    if (!ALLOWED_AUDIO_TYPES.has(file.type)) {
      setError("Use M4A, MP3, WAV, MP4 audio, or WebM audio.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const upload = await api<{
        uploadUrl: string;
        recordingId: string;
        recording_id?: string;
      }>("/call-recordings/upload-url", {
        method: "POST",
        json: {
          entityType,
          entityId,
          filename: file.name,
          mimeType: file.type,
          title: title || undefined,
          notes: notes || undefined,
          callDate: callDate ? new Date(callDate).toISOString() : undefined,
        },
      });

      await putFile(upload.uploadUrl, file, setProgress);
      const durationSeconds = await getAudioDuration(file);
      await api(`/call-recordings/${upload.recordingId ?? upload.recording_id}/confirm`, {
        method: "POST",
        json: {
          fileSizeBytes: file.size,
          durationSeconds,
        },
      });

      toast.success("Call recording uploaded");
      reset();
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Recording</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="recording-file">Audio file</Label>
            <Input id="recording-file" ref={fileInputRef} type="file" accept="audio/*" disabled={submitting} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="recording-title">Title</Label>
              <Input id="recording-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={submitting} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recording-date">Call date</Label>
              <Input id="recording-date" type="datetime-local" value={callDate} onChange={(event) => setCallDate(event.target.value)} disabled={submitting} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recording-notes">Notes</Label>
            <Textarea id="recording-notes" value={notes} onChange={(event) => setNotes(event.target.value)} disabled={submitting} />
          </div>
          {submitting && (
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-brand-red transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              <Upload className="mr-2 h-4 w-4" />
              {submitting ? "Uploading..." : "Upload Recording"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
