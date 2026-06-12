import React, { useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { theme } from "../theme/theme";
import { Button } from "../components/ui";

export type CapturedShot = { uri: string; width?: number; height?: number; exif?: Record<string, unknown> };

/**
 * Full-screen BURST camera. Each shutter tap captures and drops a thumbnail into
 * the session, then STAYS OPEN ready for the next shot — there is deliberately no
 * caption/description prompt here (captions happen later in the review tray, and
 * are optional). Live capture requires a physical device; the iOS Simulator has
 * no camera, so this surface is exercised on-device only.
 *
 * Lazy-loaded by the capture screen so importing from the library never loads
 * expo-camera's native module (keeps the Import flow working in the Simulator).
 */
export default function CameraCapture({
  onCapture,
  onClose,
  count,
  recent,
}: {
  onCapture: (shot: CapturedShot) => void;
  onClose: () => void;
  count: number;
  recent: string[];
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  async function shoot() {
    if (busy || !ready || !cameraRef.current) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1, exif: true });
      if (photo?.uri) {
        onCapture({ uri: photo.uri, width: photo.width, height: photo.height, exif: photo.exif as Record<string, unknown> });
      }
    } catch {
      /* capture must never block; swallow a single failed shot */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
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
                {ready ? "Tap to capture — camera stays open for the next shot" : "Preparing camera…"}
              </Text>
            </View>
          </SafeAreaView>
        </View>
      )}
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
  permWrap: { flex: 1, backgroundColor: theme.color.surfaceApp, padding: theme.space.xl, gap: theme.space.md, justifyContent: "center" },
  permTitle: { fontFamily: theme.font.bold, fontSize: 20, color: theme.color.textPrimary },
  permText: { fontFamily: theme.font.body, fontSize: 15, color: theme.color.textMuted, marginBottom: theme.space.sm },
});
