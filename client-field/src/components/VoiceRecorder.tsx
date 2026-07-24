import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { Button } from "./ui";
import { transcribeDescriptionAudio } from "../lib/photo-dictation";

type VoiceRecorderProps = {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  /** Optional: fires true while recording or transcribing, false when idle — lets a parent block an action
   * (e.g. submit/generate) that would otherwise drop an in-flight transcript. */
  onBusyChange?: (busy: boolean) => void;
};

// "starting" covers the async gap between the user tapping the mic and getUserMedia resolving (the permission
// prompt / device warm-up): the recorder is already "busy" then, even though no audio is flowing yet.
type RecorderState = "idle" | "starting" | "recording" | "transcribing";

const MAX_RECORDING_MS = 60_000;

export function VoiceRecorder({ disabled, onTranscript, onBusyChange }: VoiceRecorderProps) {
  const [state, setState] = useState<RecorderState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const onBusyChangeRef = useRef(onBusyChange);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Set on SETUP (not just cleanup) so React.StrictMode's dev setup→cleanup→setup cycle leaves the flag
    // true — otherwise it stays false and every later getUserMedia result is treated as post-unmount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      // Guarantee a terminal "not busy" on unmount so a parent that gates on this (e.g. a Generate button)
      // can never get stuck disabled if we unmount mid-recording/transcribing.
      onBusyChangeRef.current?.(false);
    };
  }, []);

  // Keep the latest callback in a ref and notify the parent whenever busy-ness changes (recording OR
  // transcribing), without re-firing when the parent re-renders with a new inline callback.
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });
  useEffect(() => {
    onBusyChangeRef.current?.(state !== "idle");
  }, [state]);

  async function start() {
    setError(null);
    if (state !== "idle") return; // guard re-entry during the async start window
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice dictation is not available in this browser. Use the keyboard option instead.");
      return;
    }

    // Mark busy up-front so a parent gate (e.g. Generate) is engaged during the permission prompt / device
    // startup, before recording actually begins.
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access is blocked. Enable microphone permission or use the keyboard option.");
      setState("idle");
      return;
    }

    // If we were torn down while permission was pending, release the mic immediately and do NOT start
    // recording — otherwise the live stream escapes cleanup and the mic stays on after the UI is gone.
    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    // Recorder construction / start() can throw (inactive stream, unsupported recording). Keep it inside a
    // guard so a failure returns to idle and releases the mic instead of leaving the UI stuck on "Starting…".
    try {
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      streamRef.current = stream;
      chunksRef.current = [];
      setSeconds(0);

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        void finishRecording();
      }, { once: true });

      intervalRef.current = window.setInterval(() => {
        setSeconds((current) => current + 1);
      }, 1000);
      timeoutRef.current = window.setTimeout(() => {
        stop();
      }, MAX_RECORDING_MS);

      recorder.start();
      setState("recording");
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      streamRef.current = null;
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      timeoutRef.current = null;
      intervalRef.current = null;
      setError("Voice dictation could not start. Try again or use the keyboard option.");
      setState("idle");
    }
  }

  function stop() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
  }

  async function finishRecording() {
    const recorder = recorderRef.current;
    const mimeType = recorder?.mimeType || "audio/webm";
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;

    const audio = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (!audio.size) {
      setError("No audio was captured. Try again.");
      setState("idle");
      return;
    }

    setState("transcribing");
    try {
      const result = await transcribeDescriptionAudio({
        audio,
        mimeType,
        fileName: `photo-description-${Date.now()}.${mimeType.includes("mp4") ? "m4a" : "webm"}`,
      });
      // If we were torn down mid-transcription, drop the result — delivering it would write dictation from an
      // abandoned report into whatever report is open now (the parent state survives the modal close/reopen).
      if (!mountedRef.current) return;
      onTranscript(result.transcript);
      setState("idle");
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Voice transcription failed.");
      setState("idle");
    }
  }

  const recording = state === "recording";
  const transcribing = state === "transcribing";
  const starting = state === "starting";
  const pending = starting || transcribing;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={recording ? "danger" : "ghost"}
          disabled={disabled || pending}
          aria-label={recording ? "Stop voice dictation" : "Start voice dictation"}
          onClick={() => {
            if (recording) {
              stop();
            } else {
              void start();
            }
          }}
        >
          {pending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : recording ? <Square className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
          {transcribing ? "Transcribing..." : starting ? "Starting..." : recording ? `Stop (${seconds}s)` : "Voice"}
        </Button>
        {recording ? <span className="text-xs font-bold text-red-200">Recording now</span> : null}
      </div>
      {error ? <p className="text-xs font-semibold text-red-200">{error}</p> : null}
    </div>
  );
}
