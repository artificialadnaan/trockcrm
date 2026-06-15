import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { theme } from "../theme/theme";
import { Button } from "../components/ui";
import { PhotoCaptionEditor } from "../components/PhotoCaptionEditor";

export type CapturedShot = { uri: string; width?: number; height?: number; exif?: Record<string, unknown> };

/**
 * Full-screen BURST camera with two modes (driven by `annotatePerShot`):
 *  - batch (false): each shutter tap captures and drops the shot into the session,
 *    then STAYS OPEN ready for the next — captions happen later in the review tray.
 *  - document-as-you-go (true): after each shot the per-photo note editor slides up
 *    OVER the live camera (the camera stays mounted, so the GPS session and preview
 *    persist); the crew dictates/types a note for THAT shot, then Save & next / Skip
 *    returns to the camera for the next one.
 *
 * Live capture requires a physical device; the iOS Simulator has no camera, so this
 * surface is exercised on-device only. Lazy-loaded by the capture screen so importing
 * from the library never loads expo-camera's native module.
 */
export default function CameraCapture({
  onCapture,
  onClose,
  count,
  recent,
  annotatePerShot = false,
  voiceEnabled = false,
}: {
  /** Commit a shot with its (optional) per-photo caption — "" when none was added. */
  onCapture: (shot: CapturedShot, caption: string) => void;
  onClose: () => void;
  count: number;
  recent: string[];
  annotatePerShot?: boolean;
  voiceEnabled?: boolean;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  // The just-captured shot awaiting its note (document-as-you-go); null = live camera.
  const [pending, setPending] = useState<CapturedShot | null>(null);
  const [draft, setDraft] = useState("");
  // Held true while the note's dictation is recording/transcribing so Save & next /
  // Skip / Discard can't fire mid-flight and drop the transcript.
  const [voiceBusy, setVoiceBusy] = useState(false);

  async function shoot() {
    if (busy || !ready || !cameraRef.current || pending) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1, exif: true });
      if (photo?.uri) {
        const shot: CapturedShot = {
          uri: photo.uri,
          width: photo.width,
          height: photo.height,
          exif: photo.exif as Record<string, unknown>,
        };
        if (annotatePerShot) {
          // Don't commit yet — prompt for this shot's note first, then commit on Save/Skip.
          setDraft("");
          setVoiceBusy(false);
          setPending(shot);
        } else {
          onCapture(shot, "");
        }
      }
    } catch {
      /* capture must never block; swallow a single failed shot */
    } finally {
      setBusy(false);
    }
  }

  // Commit the pending shot with the note (Save & next) or without one (Skip), then
  // return to the live camera for the next shot. The voiceBusy guard mirrors the
  // disabled buttons defensively — never commit mid-dictation (would drop the transcript).
  function commit(caption: string) {
    if (voiceBusy) return;
    const shot = pending;
    if (!shot) return;
    setPending(null);
    setDraft("");
    setVoiceBusy(false);
    onCapture(shot, caption);
  }

  // Drop the pending shot entirely (a fat-fingered frame) — nothing is added.
  function discard() {
    if (voiceBusy) return;
    setPending(null);
    setDraft("");
    setVoiceBusy(false);
  }

  // Hardware back / dismiss gesture must not silently drop a shot mid-annotation or cut off
  // an in-flight voice transcription — require an explicit Save & next / Skip / Discard first.
  function handleRequestClose() {
    if (voiceBusy || pending) return;
    onClose();
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={handleRequestClose}>
      {/* A Modal renders in its own native window outside the app's SafeAreaProvider,
          so the overlay's SafeAreaView needs its own provider to resolve real insets —
          otherwise the counter/Done land under the status bar / Dynamic Island. */}
      <SafeAreaProvider>
        {!permission ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.color.brandRed} />
          </View>
        ) : !permission.granted ? (
          <SafeAreaView style={styles.permWrap}>
            <Text style={styles.permTitle}>Camera access</Text>
            <Text style={styles.permText}>T-Rock Cam needs the camera to capture jobsite photos.</Text>
            <Button title="Grant camera access" onPress={() => void requestPermission()} />
            <Button title="Close" variant="ghost" onPress={onClose} />
          </SafeAreaView>
        ) : (
          <View style={styles.fill}>
            <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" onCameraReady={() => setReady(true)} />

            {/* Live capture controls — hidden while a shot is being annotated so the
                shutter can't double-fire and "Done" can't skip the pending note. The
                existing top/bottom safe-area handling is untouched. */}
            {!pending ? (
              <SafeAreaView style={styles.overlay} edges={["top", "bottom"]}>
                <View style={styles.topBar}>
                  <Text style={styles.counter}>
                    {count} photo{count === 1 ? "" : "s"}
                  </Text>
                  <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Done capturing">
                    <Text style={styles.done}>Done</Text>
                  </Pressable>
                </View>

                <View style={styles.bottom}>
                  {recent.length > 0 ? (
                    <View style={styles.strip}>
                      {recent.map((uri, i) => (
                        <Image key={`${uri}-${i}`} source={{ uri }} style={styles.stripThumb} />
                      ))}
                    </View>
                  ) : null}
                  <Pressable
                    onPress={shoot}
                    disabled={busy || !ready}
                    style={({ pressed }) => [styles.shutter, (busy || !ready || pressed) && { opacity: 0.5 }]}
                    accessibilityLabel="Capture photo"
                  >
                    <View style={styles.shutterInner} />
                  </Pressable>
                  <Text style={styles.hint}>
                    {ready
                      ? annotatePerShot
                        ? "Tap to capture — you'll add a note for each photo"
                        : "Tap to capture — camera stays open for the next shot"
                      : "Preparing camera…"}
                  </Text>
                </View>
              </SafeAreaView>
            ) : null}

            {/* After-each-shot note editor — slides up over the live camera. Owns its
                own keyboard handling (KeyboardAvoidingView) + bottom inset so it never
                regresses the camera's controls underneath. */}
            {pending ? (
              <KeyboardAvoidingView
                style={styles.annotateRoot}
                behavior={Platform.OS === "ios" ? "padding" : undefined}
              >
                <View style={styles.scrim} pointerEvents="none" />
                <SafeAreaView edges={["bottom"]} style={styles.annotateSheet}>
                  <PhotoCaptionEditor
                    uri={pending.uri}
                    caption={draft}
                    onChangeCaption={setDraft}
                    onAppendCaption={(text) => setDraft((prev) => (prev ? `${prev} ${text}` : text))}
                    voiceEnabled={voiceEnabled}
                    onBusyChange={setVoiceBusy}
                    label="Add a note for this photo"
                    hint="Optional — dictate or type, then continue."
                    footer={
                      <View style={styles.annotateActions}>
                        <Button title="Save & next" onPress={() => commit(draft)} disabled={voiceBusy} />
                        <Button title="Skip" variant="ghost" onPress={() => commit("")} disabled={voiceBusy} />
                        <Pressable
                          onPress={discard}
                          disabled={voiceBusy}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Discard this photo"
                        >
                          <Text style={[styles.discard, voiceBusy && styles.discardDisabled]}>Discard photo</Text>
                        </Pressable>
                      </View>
                    }
                  />
                </SafeAreaView>
              </KeyboardAvoidingView>
            ) : null}
          </View>
        )}
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  counter: {
    color: theme.color.textInverse,
    fontFamily: theme.font.semibold,
    fontSize: 15,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: theme.space.md,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    overflow: "hidden",
  },
  done: {
    color: theme.color.textInverse,
    fontFamily: theme.font.bold,
    fontSize: 17,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: theme.space.md,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    overflow: "hidden",
  },
  bottom: { alignItems: "center", gap: theme.space.md, paddingBottom: theme.space.md },
  strip: { flexDirection: "row", gap: theme.space.xs, paddingHorizontal: theme.space.lg },
  stripThumb: { width: 48, height: 48, borderRadius: theme.radius.sm, borderWidth: 1, borderColor: "rgba(255,255,255,0.6)" },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: "#fff" },
  hint: { color: theme.color.textInverse, fontFamily: theme.font.body, fontSize: 13, opacity: 0.85 },
  annotateRoot: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(15,17,21,0.55)" },
  annotateSheet: {
    backgroundColor: theme.color.surfaceCard,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  annotateActions: { gap: theme.space.sm },
  discard: {
    fontFamily: theme.font.semibold,
    fontSize: 14,
    color: theme.color.textMuted,
    textAlign: "center",
    paddingTop: theme.space.xs,
  },
  discardDisabled: { opacity: 0.4 },
  permWrap: { flex: 1, backgroundColor: theme.color.surfaceApp, padding: theme.space.xl, gap: theme.space.md, justifyContent: "center" },
  permTitle: { fontFamily: theme.font.bold, fontSize: 20, color: theme.color.textPrimary },
  permText: { fontFamily: theme.font.body, fontSize: 15, color: theme.color.textMuted, marginBottom: theme.space.sm },
});
