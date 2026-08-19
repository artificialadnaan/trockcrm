import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { theme } from "../theme/theme";
import { useAuth } from "../auth/AuthContext";
import { transcribeAudio } from "../dictation/transcribe";

// "starting" = permission prompt + audio-session/recorder setup, before the first
// frame is recorded — counts as busy so a parent can't tear us down mid-start.
//
// "formatting" = the parent's onTranscript handler is still running. It exists because a handler may now
// be ASYNC (the weekly-report wizard sends the transcript to the server-side dictation pass), and that
// round trip is a second window in which the recorder can be unmounted with the transcript still in
// flight — a longer one than transcription, on exactly the connections this feature is written for.
// Every non-idle status reports busy, so extending the enum is what extends the parent's guard.
type Status = "idle" | "starting" | "recording" | "transcribing" | "formatting";

const MAX_SECONDS = 60;

/**
 * Mirrors client-field VoiceRecorder: record (≤60s, auto-stop), transcribe on
 * stop, append the transcript to the description. Uses expo-audio for capture
 * and the raw-body transcribe endpoint (with 2-retry/backoff) under the hood.
 */
export function VoiceRecorder({
  onTranscript,
  onBusyChange,
  label = "🎤 Dictate description",
}: {
  // May be async. If it returns a promise, this component stays BUSY until it settles — see `stop()`.
  onTranscript: (text: string) => void | Promise<void>;
  // Reports recording/transcribing/formatting so a parent can block teardown (e.g. closing a
  // sheet) that would abandon an in-flight recording and lose the dictated text.
  onBusyChange?: (busy: boolean) => void;
  // Idle-state button label (e.g. "🎤 Dictate summary" in the report builder).
  label?: string;
}) {
  const { token, activeOfficeId } = useAuth();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [status, setStatus] = useState<Status>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Synchronous mirror of `status` so the auto-stop interval (whose `stop`
  // closure was captured before `setStatus("recording")` flushed) reads the
  // CURRENT state instead of a stale one — otherwise the 60s cap never fires.
  const statusRef = useRef<Status>("idle");
  function applyStatus(next: Status) {
    statusRef.current = next;
    setStatus(next);
  }

  function clearTick() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  useEffect(() => clearTick, []);

  // Surface busy state to the parent; report idle on unmount as a backstop.
  useEffect(() => {
    onBusyChange?.(status !== "idle");
  }, [status, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function start() {
    setError(null);
    // Mark busy up-front so the permission prompt + setup window counts as in-flight.
    applyStatus("starting");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission is required for voice notes.");
        applyStatus("idle");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setSeconds(0);
      applyStatus("recording");
      tickRef.current = setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next >= MAX_SECONDS) void stop();
          return next;
        });
      }, 1000);
    } catch {
      setError("Could not start recording.");
      applyStatus("idle");
    }
  }

  async function stop() {
    clearTick();
    if (statusRef.current !== "recording") return;
    applyStatus("transcribing");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri || !token) throw new Error("No audio captured.");
      const result = await transcribeAudio({
        token,
        officeId: activeOfficeId,
        fileUri: uri,
        mimeType: "audio/m4a",
        fileName: "voice-note.m4a",
      });
      const transcript = result.transcript?.trim();
      if (transcript) {
        // AWAITED, not fired and forgotten. A handler that post-processes the transcript over the network
        // (the weekly-report wizard's server-side dictation pass) is still holding the only copy of what
        // was said; returning to "idle" here would tell the parent it is safe to unmount, and the spoken
        // paragraph would go with it. Awaiting keeps `onBusyChange(true)` in force until the handler is
        // genuinely done — a synchronous handler simply resolves on the next microtask.
        applyStatus("formatting");
        await onTranscript(transcript);
      } else setError("No speech detected.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcription failed.");
    } finally {
      applyStatus("idle");
      setSeconds(0);
    }
  }

  const recording = status === "recording";
  const transcribing = status === "transcribing";
  const formatting = status === "formatting";
  const starting = status === "starting";

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={recording ? stop : start}
        disabled={transcribing || formatting || starting}
        accessibilityRole="button"
        accessibilityLabel={recording ? "Stop voice note" : "Record voice note"}
        style={({ pressed }) => [
          styles.button,
          recording && styles.buttonRecording,
          (transcribing || formatting || starting) && styles.buttonBusy,
          pressed && { opacity: 0.85 },
        ]}
      >
        <Text style={styles.buttonText}>
          {transcribing
            ? "Transcribing…"
            : formatting
              ? "Tidying up…"
              : starting
                ? "Starting…"
                : recording
                  ? `Stop · ${String(seconds).padStart(2, "0")}s`
                  : label}
        </Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonRecording: { backgroundColor: theme.color.brandRed, borderColor: theme.color.brandRed },
  buttonBusy: { opacity: 0.7 },
  buttonText: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  error: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.danger },
});
