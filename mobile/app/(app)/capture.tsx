import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
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
import { type CaptureTargetRef } from "../../src/capture/upload";
import { drainUploadQueue, enqueueUploads, getQueuedCount, newClientUploadId } from "../../src/capture/upload-queue";
import { registerUploadBackgroundTask } from "../../src/capture/upload-background-task";
import { applyGpsToPending, buildCaptureUploadInput, type SessionPhoto } from "../../src/capture/session-photo";
import type { CapturedShot } from "../../src/capture/CameraCapture";
import { DEFAULT_CAPTURE_MODE, loadCaptureMode, saveCaptureMode, type CaptureMode } from "../../src/capture/capture-mode";
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
    projectNumber?: string;
    stage?: string;
    propertyAddress?: string;
  }>();
  const router = useRouter();
  const { fetcher, user } = useAuth();
  const qc = useQueryClient();
  // The upload queue is namespaced per signed-in user so one user's queued photos can never drain under
  // the next person who signs in on this device.
  const ownerKey = user?.id ?? "";

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
  // Held true while the batch dictation is recording/transcribing, so an Upload
  // (which clears photos and unmounts VoiceRecorder) can't abandon it mid-flight.
  const [batchVoiceBusy, setBatchVoiceBusy] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<UploadStatus>("idle");
  // How many photos are durably queued but not yet uploaded (persists across app restarts). Drives the
  // "pending upload" banner + Resume action.
  const [queuedCount, setQueuedCount] = useState(0);
  const [notice, setNotice] = useState<
    { tone: "error" | "success"; text: string; viewTarget?: SelectedTarget } | null
  >(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Camera mode: per-photo (document-as-you-go, the default) vs. batch (burst then
  // caption in the tray). Loaded from / persisted to secure-store so it sticks.
  const [mode, setMode] = useState<CaptureMode>(DEFAULT_CAPTURE_MODE);
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

  // Restore the saved camera mode once on mount (default applies until it resolves).
  useEffect(() => {
    void loadCaptureMode().then(setMode);
  }, []);

  function changeMode(next: CaptureMode) {
    setMode(next);
    void saveCaptureMode(next);
  }

  const pendingQuery = usePendingPhotos();
  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });

  // Auto-dismiss a success banner (~4s) so a saved-and-done state doesn't keep
  // sitting next to the "ready for the next capture" empty state and read as pending.
  useEffect(() => {
    if (notice?.tone !== "success") return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  function nextKey() {
    keyCounter.current += 1;
    return `sp-${keyCounter.current}`;
  }

  function invalidateDealPhotos(dealId: string) {
    if (user) void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, dealId) });
  }

  function detailParamsFor(
    t: SelectedTarget,
  ): { id: string; name: string; projectNumber?: string; stage?: string; propertyAddress?: string } {
    const out: { id: string; name: string; projectNumber?: string; stage?: string; propertyAddress?: string } = {
      id: t.id,
      name: t.name,
    };
    if (typeof params.dealId === "string" && params.dealId === t.id) {
      if (typeof params.projectNumber === "string") out.projectNumber = params.projectNumber;
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
      return { key: nextKey(), clientUploadId: newClientUploadId(), uri: asset.uri, width: asset.width, height: asset.height, metadata, caption: "" };
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

  function onCameraCapture(shot: CapturedShot, caption: string) {
    const key = nextKey();
    // Honor the shot's own EXIF (DateTimeOriginal + any embedded GPS), mirroring the
    // import path; else the live session GPS; else back-patch when getLiveGps() lands.
    const exifMeta = extractExifMetadata(shot.exif);
    const gps = cameraGpsRef.current;
    // Per-photo mode commits a shot only after its note is dismissed, so fall back to the shutter
    // timestamp (shot.capturedAt, always stamped at capture) rather than commit-time now() — keeps the
    // recorded capture time at when it was shot, not when it was annotated.
    const takenAt = exifMeta.takenAt ?? shot.capturedAt;
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
      { key, clientUploadId: newClientUploadId(), uri: shot.uri, width: shot.width, height: shot.height, metadata, caption, cameraSession: cameraSessionRef.current },
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

  // Functional append (reads the live caption) so back-to-back voice transcripts
  // can't overwrite each other via a stale captured value.
  function appendPhotoCaption(key: string, text: string) {
    setPhotos((prev) =>
      prev.map((p) => (p.key === key ? { ...p, caption: p.caption ? `${p.caption} ${text}` : text } : p)),
    );
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
    router.setParams({ dealId: "", targetName: "", projectNumber: "", stage: "", propertyAddress: "" });
  }

  const refreshQueuedCount = useCallback(async () => {
    if (!ownerKey) return;
    setQueuedCount(await getQueuedCount(ownerKey));
  }, [ownerKey]);

  // Drain the durable upload queue. Used by the Resume action, the on-mount resume of a queue left over
  // from a previous session/crash, and the return-to-foreground resume. drainUploadQueue keeps the screen
  // awake while it runs and dedupes server-side, so this is safe to call repeatedly.
  const resumeQueue = useCallback(async () => {
    if (!ownerKey || status === "uploading") return;
    setStatus("uploading");
    setNotice(null);
    const summary = await drainUploadQueue(ownerKey, fetcher);
    await refreshQueuedCount();
    void pendingQuery.refetch();
    if (summary.remaining === 0) {
      setStatus("idle");
      if (summary.succeeded > 0) {
        setNotice({ tone: "success", text: `${summary.succeeded} queued photo${summary.succeeded === 1 ? "" : "s"} uploaded.` });
      }
    } else {
      setStatus("failed");
      setNotice({ tone: "error", text: `${summary.remaining} photo${summary.remaining === 1 ? "" : "s"} still queued — they'll keep retrying.` });
    }
  }, [fetcher, ownerKey, pendingQuery, refreshQueuedCount, status]);

  // On mount (per signed-in user): schedule the background drain and resume any queue left over from a
  // previous run; also resume whenever the app returns to the foreground. The latest resumeQueue is read
  // via a ref so the listener never goes stale.
  const resumeQueueRef = useRef(resumeQueue);
  useEffect(() => {
    resumeQueueRef.current = resumeQueue;
  }, [resumeQueue]);
  useEffect(() => {
    if (!ownerKey) return;
    void registerUploadBackgroundTask();
    let cancelled = false;
    const resumeIfQueued = async () => {
      const n = await getQueuedCount(ownerKey);
      if (cancelled) return;
      setQueuedCount(n);
      if (n > 0) void resumeQueueRef.current();
    };
    void resumeIfQueued();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void resumeIfQueued();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [ownerKey]);

  async function upload() {
    if (!ownerKey || photos.length === 0 || status === "uploading") return;
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
    // One mapping for every shot: per-photo caption wins over the batch caption, and a
    // resolved session GPS reconciles only into still-ungeotagged shots FROM THAT session
    // (an earlier session's shot is never geotagged with it). The note a crew dictated for
    // a shot rides with THAT shot — see session-photo.buildCaptureUploadInput.
    const inputs = photos.map((sp) =>
      buildCaptureUploadInput(sp, { target: ref, category, tags, batchCaption, sessionGps, gpsSession }),
    );
    const destName = target ? target.name : "Pending";
    const viewTarget = target?.type === "deal" ? target : undefined;

    // Persist the whole batch to the durable queue FIRST, so a crash/kill/connection drop can't lose it.
    try {
      await enqueueUploads(ownerKey, inputs);
    } catch {
      setStatus("failed");
      setNotice({ tone: "error", text: "Couldn't save photos for upload. Please try again." });
      return;
    }
    // The batch is durable now — clear the in-memory tray so the crew can keep capturing while it uploads.
    setPhotos([]);
    setBatchCaption("");
    setTags([]);
    setCategory(null);
    await refreshQueuedCount();

    const summary = await drainUploadQueue(ownerKey, fetcher);
    await refreshQueuedCount();
    void pendingQuery.refetch();
    if (target?.type === "deal" && summary.succeeded > 0) invalidateDealPhotos(target.id);

    if (summary.remaining === 0) {
      setStatus("idle");
      // Name the destination so the green banner is unambiguous; a deal target also gets a "View" action.
      setNotice({
        tone: "success",
        text: `${summary.succeeded} photo${summary.succeeded === 1 ? "" : "s"} saved to ${destName}.`,
        viewTarget,
      });
      if (target?.type === "deal") {
        const fromAccessibleProject = typeof params.dealId === "string" && params.dealId === target.id;
        if (fromAccessibleProject) {
          router.replace({ pathname: "/(app)/projects/[id]", params: detailParamsFor(target) });
        }
      }
    } else {
      setStatus("failed");
      setNotice({
        tone: "error",
        text: `${summary.succeeded} uploaded, ${summary.remaining} still queued — they'll keep retrying. Tap Resume to try now.`,
      });
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
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      >
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

        {notice ? (
          <Banner
            message={notice.text}
            tone={notice.tone}
            action={
              notice.viewTarget
                ? {
                    label: "View",
                    onPress: () =>
                      router.push({ pathname: "/(app)/projects/[id]", params: detailParamsFor(notice.viewTarget!) }),
                  }
                : undefined
            }
          />
        ) : null}

        {/* Durable queue: photos saved on-device but not yet uploaded (survives restarts). Auto-resumes,
            but a manual Resume is offered for an immediate retry. Hidden while a drain is in progress. */}
        {queuedCount > 0 && !uploading ? (
          <Banner
            message={`${queuedCount} photo${queuedCount === 1 ? "" : "s"} waiting to upload. They'll keep retrying automatically.`}
            tone="error"
            action={{ label: "Resume", onPress: () => void resumeQueue() }}
          />
        ) : null}

        {/* Camera mode — per-photo (document-as-you-go) vs. batch (burst, caption after) */}
        <View style={styles.modeRow}>
          <Text style={styles.modeLabel}>Camera</Text>
          <View style={styles.segment}>
            {([
              ["perPhoto", "One at a time"],
              ["batch", "Batch"],
            ] as const).map(([value, label]) => {
              const active = mode === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => changeMode(value)}
                  disabled={uploading}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: uploading }}
                  accessibilityLabel={`${label} camera mode`}
                  style={[styles.segBtn, active && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, active && styles.segTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

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
            <ReviewTray
              photos={photos}
              onSetCaption={setPhotoCaption}
              onAppendCaption={appendPhotoCaption}
              onRemove={removePhoto}
              disabled={uploading}
              voiceEnabled={transcribeConfig.data?.configured ?? false}
            />

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
                    <VoiceRecorder
                      onTranscript={(text) => setBatchCaption((prev) => (prev ? `${prev} ${text}` : text))}
                      onBusyChange={setBatchVoiceBusy}
                    />
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
              disabled={uploading || batchVoiceBusy}
            />
          </View>
        ) : (
          <View style={styles.emptyWrap}>
            <EmptyState
              title={target ? "Ready for the next capture" : "No photos yet"}
              subtitle={
                target
                  ? `New photos will be saved to ${target.name}.`
                  : "Open the camera to burst-capture, or import from your library."
              }
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
            annotatePerShot={mode === "perPhoto"}
            voiceEnabled={transcribeConfig.data?.configured ?? false}
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
  modeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.md },
  modeLabel: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.textMuted },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: 2,
  },
  segBtn: { paddingHorizontal: theme.space.md, paddingVertical: 6, borderRadius: theme.radius.sm },
  segBtnActive: { backgroundColor: theme.color.surfaceCard, borderWidth: 1, borderColor: theme.color.border },
  segText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted },
  segTextActive: { color: theme.color.textPrimary },
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
