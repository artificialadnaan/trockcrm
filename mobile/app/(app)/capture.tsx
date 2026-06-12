import React, { Suspense, useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../src/theme/theme";
import { useAuth } from "../../src/auth/AuthContext";
import { usePendingPhotos } from "../../src/query/hooks";
import { qk } from "../../src/query/keys";
import { assignPhotoTarget, getTranscriptionConfig } from "../../src/api/endpoints";
import type { FieldCaptureTarget } from "../../src/api/types";
import { extractExifMetadata, getLiveGps, type PhotoMetadata } from "../../src/capture/metadata";
import { runConcurrentUploads, uploadCapture, type CaptureTargetRef } from "../../src/capture/upload";
import { applyGpsToPending, effectiveCaption, reconcileUploadGps, type SessionPhoto } from "../../src/capture/session-photo";
import type { CapturedShot } from "../../src/capture/CameraCapture";
import { Badge, Button, EmptyState, TextInput } from "../../src/components/ui";
import { Banner } from "../../src/components/Banner";
import { CategoryPicker } from "../../src/components/CategoryPicker";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { PhotoTagInput } from "../../src/components/PhotoTagInput";
import { VoiceRecorder } from "../../src/components/VoiceRecorder";
import { TargetPicker } from "../../src/components/TargetPicker";
import { ReviewTray } from "../../src/components/ReviewTray";

// Lazy so the Import path never loads expo-camera's native module (live camera is
// a physical-device-only surface; the iOS Simulator has no camera).
const CameraCapture = React.lazy(() => import("../../src/capture/CameraCapture"));

type SelectedTarget = { id: string; type: "deal" | "lead" | "opportunity"; name: string };
type UploadStatus = "idle" | "uploading" | "failed";

function targetRef(t: SelectedTarget | null): CaptureTargetRef {
  if (!t) return {};
  if (t.type === "deal") return { dealId: t.id };
  if (t.type === "lead") return { leadId: t.id };
  return { opportunityId: t.id };
}

function hasCoords(m: PhotoMetadata): boolean {
  return m.latitude !== undefined && m.longitude !== undefined;
}

export default function CaptureScreen() {
  const params = useLocalSearchParams<{
    dealId?: string;
    targetName?: string;
    dealNumber?: string;
    stage?: string;
    propertyAddress?: string;
  }>();
  const router = useRouter();
  const { fetcher, user } = useAuth();
  const qc = useQueryClient();

  const initialTarget: SelectedTarget | null =
    typeof params.dealId === "string" && params.dealId
      ? { id: params.dealId, type: "deal", name: typeof params.targetName === "string" ? params.targetName : "Project" }
      : null;

  const [target, setTarget] = useState<SelectedTarget | null>(initialTarget);

  // Capture is a tab and stays mounted; re-sync the target when "Add photos" is
  // tapped from a (different) project so the upload attaches to the chosen one.
  useEffect(() => {
    if (typeof params.dealId === "string" && params.dealId) {
      setTarget({
        id: params.dealId,
        type: "deal",
        name: typeof params.targetName === "string" ? params.targetName : "Project",
      });
    }
  }, [params.dealId, params.targetName]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [assigningPhotoId, setAssigningPhotoId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<SessionPhoto[]>([]);
  const [batchCaption, setBatchCaption] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const keyCounter = useRef(0);
  // Live GPS fetched once per camera session so burst shots aren't each blocked
  // on a fresh fix (a burst is at one location); applied to every shot.
  const cameraGpsRef = useRef<PhotoMetadata | null>(null);
  // Keys of shots captured before this session's GPS fix resolved — back-patched
  // with the coordinates once getLiveGps() returns (capture never waits on it).
  const pendingGpsKeysRef = useRef<Set<string>>(new Set());
  // Monotonic camera-session token: a late getLiveGps() from a PRIOR session (the
  // user reopened the camera before it resolved) must not overwrite or back-patch
  // the current session with a stale fix.
  const cameraSessionRef = useRef(0);
  // The in-flight getLiveGps() promise for the current session — upload() awaits it
  // so a quick burst+upload doesn't snapshot ungeotagged metadata before it lands.
  const cameraGpsPromiseRef = useRef<Promise<PhotoMetadata> | null>(null);
  // The camera session cameraGpsRef belongs to — scopes upload-time reconciliation
  // so a later session's fix can't geotag an earlier session's shot.
  const cameraGpsSessionRef = useRef<number | null>(null);

  const pendingQuery = usePendingPhotos();
  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });

  function nextKey() {
    keyCounter.current += 1;
    return `sp-${keyCounter.current}`;
  }

  function invalidateDealPhotos(dealId: string) {
    if (user) void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, dealId) });
  }

  function detailParamsFor(
    t: SelectedTarget,
  ): { id: string; name: string; dealNumber?: string; stage?: string; propertyAddress?: string } {
    const out: { id: string; name: string; dealNumber?: string; stage?: string; propertyAddress?: string } = {
      id: t.id,
      name: t.name,
    };
    if (typeof params.dealId === "string" && params.dealId === t.id) {
      if (typeof params.dealNumber === "string") out.dealNumber = params.dealNumber;
      if (typeof params.stage === "string") out.stage = params.stage;
      if (typeof params.propertyAddress === "string") out.propertyAddress = params.propertyAddress;
    }
    return out;
  }

  // Library imports keep EXIF → live-GPS fallback; caption starts empty.
  async function addAssets(assets: ImagePicker.ImagePickerAsset[]) {
    let live: PhotoMetadata | null = null;
    const needsLive = assets.some((a) => !hasCoords(extractExifMetadata(a.exif as Record<string, unknown>)));
    if (needsLive) live = await getLiveGps();

    const next: SessionPhoto[] = assets.map((asset) => {
      const exifMeta = extractExifMetadata(asset.exif as Record<string, unknown>);
      const metadata: PhotoMetadata = hasCoords(exifMeta)
        ? exifMeta
        : { ...(live ?? {}), takenAt: exifMeta.takenAt ?? live?.takenAt ?? new Date().toISOString() };
      return { key: nextKey(), uri: asset.uri, width: asset.width, height: asset.height, metadata, caption: "" };
    });
    setPhotos((prev) => [...prev, ...next]);
  }

  function openCamera() {
    if (status === "uploading") return;
    setNotice(null);
    cameraGpsRef.current = null;
    pendingGpsKeysRef.current = new Set();
    const session = (cameraSessionRef.current += 1);
    const gpsPromise = getLiveGps();
    cameraGpsPromiseRef.current = gpsPromise;
    void gpsPromise.then((m) => {
      // Drop a fix from a previous camera session (reopened before this resolved)
      // so it can't overwrite cameraGpsRef or back-patch the new session's shots.
      if (cameraSessionRef.current !== session) return;
      cameraGpsRef.current = m;
      cameraGpsSessionRef.current = session;
      // Geotag any shots captured before the fix arrived, then stop tracking them.
      const keys = pendingGpsKeysRef.current;
      if (keys.size > 0 && hasCoords(m)) {
        setPhotos((prev) => applyGpsToPending(prev, keys, m));
        pendingGpsKeysRef.current = new Set();
      }
    });
    setCameraOpen(true);
  }

  function onCameraCapture(shot: CapturedShot) {
    const key = nextKey();
    // Honor the shot's own EXIF (DateTimeOriginal + any embedded GPS), mirroring the
    // import path; else the live session GPS; else back-patch when getLiveGps() lands.
    const exifMeta = extractExifMetadata(shot.exif);
    const gps = cameraGpsRef.current;
    const takenAt = exifMeta.takenAt ?? new Date().toISOString();
    let metadata: PhotoMetadata;
    if (hasCoords(exifMeta)) {
      metadata = { ...exifMeta, takenAt };
    } else if (gps && hasCoords(gps)) {
      metadata = { ...gps, takenAt };
    } else {
      // Capture never blocks on GPS — keep the shot and back-patch coordinates later.
      metadata = { takenAt };
      pendingGpsKeysRef.current.add(key);
    }
    setPhotos((prev) => [
      ...prev,
      { key, uri: shot.uri, width: shot.width, height: shot.height, metadata, caption: "", cameraSession: cameraSessionRef.current },
    ]);
  }

  async function importPhotos() {
    if (status === "uploading") return;
    setNotice(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setNotice({ tone: "error", text: "Photo library permission is required to import photos." });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 1,
      exif: true,
    });
    if (!result.canceled) await addAssets(result.assets);
  }

  function removePhoto(key: string) {
    if (status === "uploading") return;
    setPhotos((prev) => prev.filter((p) => p.key !== key));
  }

  function setPhotoCaption(key: string, text: string) {
    setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, caption: text } : p)));
  }

  // Materialize the batch caption onto photos WITHOUT their own caption — keeps
  // "individual overrides batch" (never clobbers a per-photo caption).
  function applyBatchToEmpty() {
    const batch = batchCaption.trim();
    if (!batch) return;
    setPhotos((prev) => prev.map((p) => (p.caption.trim() ? p : { ...p, caption: batch })));
  }

  function clearTarget() {
    setTarget(null);
    router.setParams({ dealId: "", targetName: "", dealNumber: "", stage: "", propertyAddress: "" });
  }

  async function upload() {
    if (photos.length === 0 || status === "uploading") return;
    setStatus("uploading");
    setNotice(null);
    // Don't let a quick burst→Upload race the non-blocking GPS fix: if early shots
    // are still waiting on it, wait for the in-flight fix so the snapshot is geotagged.
    if (pendingGpsKeysRef.current.size > 0 && cameraGpsRef.current === null && cameraGpsPromiseRef.current) {
      try {
        await cameraGpsPromiseRef.current;
      } catch {
        /* best-effort — upload still proceeds */
      }
    }
    const sessionGps = cameraGpsRef.current;
    const gpsSession = cameraGpsSessionRef.current;
    const ref = targetRef(target);
    const results = await runConcurrentUploads(photos, 3, (sp) =>
      uploadCapture(fetcher, {
        uri: sp.uri,
        width: sp.width,
        height: sp.height,
        target: ref,
        category,
        // Per-photo caption wins; batch caption is the fallback for un-captioned photos.
        caption: effectiveCaption(sp.caption, batchCaption),
        tags,
        // Reconcile a resolved session GPS into still-ungeotagged shots FROM THAT
        // session only — an earlier session's shot is never geotagged with it.
        metadata: reconcileUploadGps(sp, sessionGps, gpsSession),
      }),
    );

    const failedKeys = photos.filter((_, i) => results[i]?.status === "rejected").map((p) => p.key);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;

    if (failedKeys.length === 0) {
      setPhotos([]);
      setBatchCaption("");
      setTags([]);
      setCategory(null);
      setStatus("idle");
      setNotice({ tone: "success", text: `${succeeded} photo${succeeded === 1 ? "" : "s"} uploaded.` });
      void pendingQuery.refetch();
      if (target?.type === "deal") {
        invalidateDealPhotos(target.id);
        const fromAccessibleProject = typeof params.dealId === "string" && params.dealId === target.id;
        if (fromAccessibleProject) {
          router.replace({ pathname: "/(app)/projects/[id]", params: detailParamsFor(target) });
        }
      }
    } else {
      setPhotos((prev) => prev.filter((p) => failedKeys.includes(p.key)));
      setStatus("failed");
      setNotice({
        tone: "error",
        text: `${succeeded} uploaded, ${failedKeys.length} failed. Tap upload to retry the rest.`,
      });
      void pendingQuery.refetch();
      if (target?.type === "deal" && succeeded > 0) invalidateDealPhotos(target.id);
    }
  }

  async function assignPending(t: FieldCaptureTarget) {
    if (!assigningPhotoId) return;
    const photoId = assigningPhotoId;
    setAssigningPhotoId(null);
    try {
      await assignPhotoTarget(
        fetcher,
        photoId,
        t.type === "deal" ? { dealId: t.id } : t.type === "lead" ? { leadId: t.id } : { opportunityId: t.id },
      );
      void pendingQuery.refetch();
      if (t.type === "deal") invalidateDealPhotos(t.id);
      setNotice({ tone: "success", text: `Photo assigned to ${t.name}.` });
    } catch {
      setNotice({ tone: "error", text: "Couldn't assign that photo." });
    }
  }

  const pending = pendingQuery.data?.photos ?? [];
  const uploading = status === "uploading";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* Target */}
        <View style={styles.targetCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.targetLabel}>Project</Text>
            <Text style={styles.targetName} numberOfLines={1}>
              {target ? target.name : "No project — uploads to Pending"}
            </Text>
          </View>
          <View style={styles.targetActions}>
            {target ? (
              <Pressable onPress={clearTarget} disabled={uploading} hitSlop={12} accessibilityLabel="Clear project">
                <Text style={[styles.link, uploading && styles.linkDisabled]}>Clear</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setPickerOpen(true)} disabled={uploading} hitSlop={12}>
              <Text style={[styles.link, uploading && styles.linkDisabled]}>{target ? "Change" : "Choose"}</Text>
            </Pressable>
          </View>
        </View>

        {notice ? <Banner message={notice.text} tone={notice.tone} /> : null}

        {/* Capture actions */}
        <View style={styles.actions}>
          <Button
            title="Open camera"
            icon={<Ionicons name="camera" size={18} color={theme.color.textInverse} />}
            onPress={openCamera}
            disabled={uploading}
            accessibilityLabel="Open camera"
            style={{ flex: 1 }}
          />
          <Button
            title="Import"
            variant="ghost"
            icon={
              <Ionicons name="images-outline" size={18} color={uploading ? theme.color.textMuted : theme.color.textPrimary} />
            }
            onPress={importPhotos}
            disabled={uploading}
            accessibilityLabel="Import photos"
            style={{ flex: 1 }}
          />
        </View>

        {photos.length > 0 ? (
          <View style={{ gap: theme.space.md }}>
            {/* Review tray (per-photo captions) */}
            <Text style={styles.fieldLabel}>Review ({photos.length})</Text>
            <ReviewTray photos={photos} onSetCaption={setPhotoCaption} onRemove={removePhoto} disabled={uploading} />

            {/* Batch metadata — locked during upload (values are snapshotted per request) */}
            <View
              pointerEvents={uploading ? "none" : "auto"}
              style={[{ gap: theme.space.md }, uploading && { opacity: 0.5 }]}
            >
              <View style={{ gap: theme.space.xs }}>
                <Text style={styles.fieldLabel}>Batch caption</Text>
                <Text style={styles.hint}>Optional — applied to any photo you don't caption individually.</Text>
                <TextInput
                  value={batchCaption}
                  onChangeText={setBatchCaption}
                  placeholder="Caption for the whole batch"
                  multiline
                  style={{ minHeight: 60, textAlignVertical: "top", paddingTop: 10 }}
                />
                <View style={styles.batchRow}>
                  {transcribeConfig.data?.configured ? (
                    <VoiceRecorder onTranscript={(text) => setBatchCaption((prev) => (prev ? `${prev} ${text}` : text))} />
                  ) : (
                    <View />
                  )}
                  <Pressable onPress={applyBatchToEmpty} hitSlop={12} accessibilityLabel="Apply batch caption to all uncaptioned photos">
                    <Text style={styles.link}>Apply to all</Text>
                  </Pressable>
                </View>
              </View>

              <View style={{ gap: theme.space.xs }}>
                <Text style={styles.fieldLabel}>Category</Text>
                <CategoryPicker value={category} onChange={setCategory} />
              </View>

              <View style={{ gap: theme.space.xs }}>
                <Text style={styles.fieldLabel}>Tags</Text>
                <PhotoTagInput tags={tags} onChange={setTags} dealId={target?.type === "deal" ? target.id : undefined} />
              </View>
            </View>

            <Button
              title={`Upload ${photos.length} photo${photos.length === 1 ? "" : "s"}`}
              onPress={upload}
              loading={uploading}
            />
          </View>
        ) : (
          <View style={styles.emptyWrap}>
            <EmptyState
              title="No photos yet"
              subtitle="Open the camera to burst-capture, or import from your library."
            />
          </View>
        )}

        {/* Pending captures */}
        {pending.length > 0 ? (
          <View style={{ gap: theme.space.sm, marginTop: theme.space.md }}>
            <Text style={styles.fieldLabel}>Pending captures ({pending.length})</Text>
            <Text style={styles.hint}>Photos uploaded without a project. Assign each to a project.</Text>
            {pending.map((photo) => (
              <View key={photo.id} style={styles.pendingRow}>
                {photo.imageUrl ? (
                  <Image source={{ uri: photo.imageUrl }} style={styles.pendingThumb} />
                ) : (
                  <View style={[styles.pendingThumb, styles.placeholder]} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.pendingName} numberOfLines={1}>
                    {photo.displayName}
                  </Text>
                  <Badge label={photo.photoCategory ?? "Uncategorized"} />
                </View>
                <Pressable onPress={() => setAssigningPhotoId(photo.id)} hitSlop={12}>
                  <Text style={styles.link}>Assign</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* Burst camera (lazy, full-screen) */}
      {cameraOpen ? (
        <Suspense fallback={null}>
          <CameraCapture
            onCapture={onCameraCapture}
            onClose={() => setCameraOpen(false)}
            count={photos.length}
            recent={photos.slice(-5).map((p) => p.uri)}
          />
        </Suspense>
      ) : null}

      {/* Target picker for the session */}
      <TargetPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(t) => {
          setTarget({ id: t.id, type: t.type, name: t.name });
          setPickerOpen(false);
        }}
      />
      {/* Target picker for assigning a pending photo */}
      <TargetPicker
        visible={assigningPhotoId !== null}
        onClose={() => setAssigningPhotoId(null)}
        onSelect={assignPending}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  // flexGrow lets the "No photos yet" empty state center in the leftover space
  // instead of hugging the buttons; no effect once the tray makes content scroll.
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl, flexGrow: 1 },
  emptyWrap: { flexGrow: 1, justifyContent: "center" },
  targetCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  targetLabel: { fontFamily: theme.font.medium, fontSize: 12, color: theme.color.textMuted },
  targetName: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.textPrimary },
  // Charcoal (not red) so the only red call-to-action in view is the primary button.
  link: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  linkDisabled: { opacity: 0.4 },
  targetActions: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  actions: { flexDirection: "row", gap: theme.space.md },
  fieldLabel: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  hint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  batchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.md },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.sm,
  },
  pendingThumb: { width: 48, height: 48, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
  pendingName: { fontFamily: theme.font.medium, fontSize: 14, color: theme.color.textPrimary },
});
