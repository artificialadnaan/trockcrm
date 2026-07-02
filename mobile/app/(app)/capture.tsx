import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../src/theme/theme";
import { useAuth } from "../../src/auth/AuthContext";
import { usePendingPhotos } from "../../src/query/hooks";
import { qk } from "../../src/query/keys";
import { assignPhotoTarget, getTranscriptionConfig, type Fetcher } from "../../src/api/endpoints";
import { apiFetch } from "../../src/api/client";
import type { FieldCaptureTarget } from "../../src/api/types";
import { extractExifMetadata, getLiveGps, type PhotoMetadata } from "../../src/capture/metadata";
import { type CaptureTargetRef } from "../../src/capture/upload";
import {
  clearFailedUploads,
  drainUploadQueue,
  enqueueUploads,
  getFailedCount,
  getQueuedCount,
  getQueuedUploads,
  newClientUploadId,
  uploadOwnerKey,
} from "../../src/capture/upload-queue";
import { registerUploadBackgroundTask } from "../../src/capture/upload-background-task";
import { buildCaptureUploadInput, type SessionPhoto } from "../../src/capture/session-photo";
import type { CapturedShot } from "../../src/capture/CameraCapture";
import { DEFAULT_CAPTURE_MODE, loadCaptureMode, saveCaptureMode, type CaptureMode } from "../../src/capture/capture-mode";
import { Badge, Button, EmptyState } from "../../src/components/ui";
import { Banner } from "../../src/components/Banner";
import { CategoryPicker } from "../../src/components/CategoryPicker";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { PhotoTagInput } from "../../src/components/PhotoTagInput";
import { TargetPicker } from "../../src/components/TargetPicker";

// Lazy so the Import path never loads expo-camera's native module (live camera is
// a physical-device-only surface; the iOS Simulator has no camera).
const CameraCapture = React.lazy(() => import("../../src/capture/CameraCapture"));

type SelectedTarget = { id: string; type: "deal" | "lead" | "opportunity"; name: string };

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
  const { fetcher, user, activeOfficeId, token, signOut } = useAuth();
  const qc = useQueryClient();
  // The upload queue is namespaced per signed-in user + RESOLVED OFFICE so one user's queued photos can
  // never drain under another account, or under a different office. Use activeOfficeId ?? tenantId (the
  // primary office) so a primary-office session is also office-bound — otherwise a primary-office rehome
  // would let old queued items drain against the new primary office.
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = uploadOwnerKey(user?.id, resolvedOfficeId ?? undefined);

  // Drains MUST send the RESOLVED office as x-office-id (the AuthContext fetcher omits it for primary
  // sessions, letting the server fall back to the CURRENT primary). Binding to the queue's office keeps a
  // primary-office queue uploading to the office it was captured under — matching the owner key + the
  // background task's fetcher.
  const queueFetcher = useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, { ...opts, token: token ?? undefined, officeId: resolvedOfficeId, onUnauthorized: () => void signOut() }),
    [token, resolvedOfficeId, signOut],
  );

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
  // Photos are streamed to the durable upload queue the instant they're captured — this is only a
  // lightweight in-session strip (uri + key) for the camera's count/recent preview, reset per camera open.
  const [sessionShots, setSessionShots] = useState<{ key: string; uri: string }[]>([]);
  // Category + tags are chosen BEFORE shooting now (streaming leaves no after-capture tray to tag in) and
  // are stamped onto every photo taken next.
  const [category, setCategory] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  // True while the background drain is actively pushing photos to the server — drives the "Uploading…"
  // indicator. It never blocks capture: the crew keeps shooting while uploads fly.
  const [draining, setDraining] = useState(false);
  // Shots that could NOT be persisted to the durable queue (storage full, or a transient sign-out that
  // cleared ownerKey). Held in memory so a streamed photo is never silently dropped — the crew can Retry.
  const [failedShots, setFailedShots] = useState<SessionPhoto[]>([]);
  const failedShotsRef = useRef<SessionPhoto[]>([]);
  useEffect(() => { failedShotsRef.current = failedShots; }, [failedShots]);
  // How many photos are durably queued but not yet uploaded (persists across app restarts).
  const [queuedCount, setQueuedCount] = useState(0);
  // Items that exhausted their retries — surfaced separately so the user can dismiss them (they're no
  // longer retried automatically).
  const [failedCount, setFailedCount] = useState(0);
  const [notice, setNotice] = useState<
    { tone: "error" | "success"; text: string; viewTarget?: SelectedTarget } | null
  >(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Camera mode: per-photo (caption each shot as you go, the default) vs. batch (fast burst, no caption
  // prompt). Loaded from / persisted to secure-store so it sticks.
  const [mode, setMode] = useState<CaptureMode>(DEFAULT_CAPTURE_MODE);
  const keyCounter = useRef(0);
  // Live GPS fetched once per camera session so burst shots aren't each blocked
  // on a fresh fix (a burst is at one location); applied to every shot.
  const cameraGpsRef = useRef<PhotoMetadata | null>(null);
  // Monotonic camera-session token: a late getLiveGps() from a PRIOR session (the
  // user reopened the camera before it resolved) must not overwrite the current session.
  const cameraSessionRef = useRef(0);
  // The in-flight getLiveGps() promise for the current session — a shot taken before the fix lands awaits
  // it (best-effort, off the shutter) so the streamed upload is still geotagged.
  const cameraGpsPromiseRef = useRef<Promise<PhotoMetadata> | null>(null);
  // The camera session cameraGpsRef belongs to — scopes upload-time reconciliation
  // so a later session's fix can't geotag an earlier session's shot.
  const cameraGpsSessionRef = useRef<number | null>(null);

  // Mirror the pieces streamPhoto stamps onto each upload into refs, so a shot streamed from a (possibly
  // memoized) camera callback always reads the CURRENT target/category/tags rather than a stale closure.
  const targetStateRef = useRef(target);
  const categoryRef = useRef(category);
  const tagsRef = useRef(tags);
  useEffect(() => { targetStateRef.current = target; }, [target]);
  useEffect(() => { categoryRef.current = category; }, [category]);
  useEffect(() => { tagsRef.current = tags; }, [tags]);

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

  const refreshQueuedCount = useCallback(async () => {
    if (!ownerKey) return;
    setQueuedCount(await getQueuedCount(ownerKey));
    setFailedCount(await getFailedCount(ownerKey));
  }, [ownerKey]);

  const dismissFailedUploads = useCallback(async () => {
    if (!ownerKey) return;
    await clearFailedUploads(ownerKey);
    await refreshQueuedCount();
  }, [ownerKey, refreshQueuedCount]);

  // Coalesced background drain: at most one runs at a time, and it re-runs if more photos got queued while
  // it was mid-flight (so a burst that streams during a drain still ships). drainUploadQueue keeps the
  // screen awake, dedupes server-side, and leaves un-confirmed items queued for retry — so this is safe to
  // call after every capture. It never flips the screen into a blocking state: capture stays live.
  const drainingRef = useRef(false);
  const redrainRef = useRef(false);
  // Reset the coalescer when the owner changes so a redrain raised under a new user/office can't re-kick the
  // previous owner's queue.
  useEffect(() => {
    drainingRef.current = false;
    redrainRef.current = false;
  }, [ownerKey]);
  const kickDrain = useCallback(async () => {
    if (!ownerKey) return;
    if (drainingRef.current) {
      redrainRef.current = true;
      return;
    }
    drainingRef.current = true;
    setDraining(true);
    let succeeded = 0;
    let remaining = 0;
    // Deal galleries to refresh = the destinations that ACTUALLY had queued photos this drain. Each queued
    // item carries its OWN target, so we invalidate by that — not by the currently-selected project, which
    // may have changed since capture (a coalesced drain can even span multiple projects).
    const dealIds = new Set<string>();
    try {
      do {
        redrainRef.current = false;
        try {
          for (const item of await getQueuedUploads(ownerKey)) {
            const did = item.target?.dealId;
            if (did) dealIds.add(did);
          }
        } catch {
          /* best-effort — gallery invalidation only */
        }
        try {
          const summary = await drainUploadQueue(ownerKey, queueFetcher);
          succeeded += summary.succeeded;
          remaining = summary.remaining;
        } catch {
          // Transient/offline — items stay queued and keep retrying; reflect the live backlog.
          remaining = await getQueuedCount(ownerKey).catch(() => remaining);
        }
      } while (redrainRef.current);
    } finally {
      drainingRef.current = false;
      setDraining(false);
    }
    await refreshQueuedCount();
    void pendingQuery.refetch();
    if (succeeded > 0) dealIds.forEach((id) => invalidateDealPhotos(id));
    // Target-agnostic (the batch may span projects) and never shown OVER an unresolved save failure.
    if (remaining === 0 && succeeded > 0 && failedShotsRef.current.length === 0) {
      setNotice({ tone: "success", text: `${succeeded} photo${succeeded === 1 ? "" : "s"} uploaded.` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, queueFetcher, refreshQueuedCount, pendingQuery]);

  // On mount (per signed-in user): schedule the background drain and resume any queue left over from a
  // previous run/crash; also resume whenever the app returns to the foreground. The latest kickDrain is read
  // via a ref so the listener never goes stale.
  const kickDrainRef = useRef(kickDrain);
  useEffect(() => { kickDrainRef.current = kickDrain; }, [kickDrain]);
  useEffect(() => {
    if (!ownerKey) return;
    void registerUploadBackgroundTask();
    let cancelled = false;
    const resumeIfQueued = async () => {
      const [n, failed] = await Promise.all([getQueuedCount(ownerKey), getFailedCount(ownerKey)]);
      if (cancelled) return;
      setQueuedCount(n);
      setFailedCount(failed);
      if (n > 0) void kickDrainRef.current();
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

  // Persist one captured/imported photo to the durable queue (stamping the CURRENT target, category, and
  // tags via refs), then kick the background drain — no separate "upload" step. Once enqueueUploads resolves
  // the photo is durable (survives crash/kill/connection drop). A capture that can't be persisted (storage
  // full, or a transient sign-out clearing ownerKey) is NEVER dropped: it's kept in the failedShots retry
  // buffer and drops off the session counter, with a sticky error, so a real photo can't vanish silently.
  const streamPhoto = useCallback(
    async (sp: SessionPhoto) => {
      const retain = () => {
        setSessionShots((prev) => prev.filter((s) => s.key !== sp.key));
        setFailedShots((prev) =>
          prev.some((p) => p.clientUploadId === sp.clientUploadId) ? prev : [...prev, sp],
        );
        setNotice({ tone: "error", text: "Some photos couldn't be saved yet — tap Retry to try again." });
      };
      if (!ownerKey) {
        retain();
        return;
      }
      const input = buildCaptureUploadInput(sp, {
        target: targetRef(targetStateRef.current),
        category: categoryRef.current,
        tags: tagsRef.current,
        batchCaption: "",
        sessionGps: cameraGpsRef.current,
        gpsSession: cameraGpsSessionRef.current,
      });
      try {
        await enqueueUploads(ownerKey, [input]);
      } catch {
        retain();
        return;
      }
      // Enqueued OK — clear it from the retry buffer if a prior attempt had parked it there.
      setFailedShots((prev) => prev.filter((p) => p.clientUploadId !== sp.clientUploadId));
      await refreshQueuedCount();
      void kickDrain();
    },
    [ownerKey, refreshQueuedCount, kickDrain],
  );

  // Re-attempt every buffered shot that failed to persist. A shot that fails again is re-buffered by
  // streamPhoto; one that succeeds is cleared.
  async function retryFailedShots() {
    const shots = failedShotsRef.current;
    if (shots.length === 0) return;
    setNotice(null);
    setFailedShots([]);
    for (const sp of shots) await streamPhoto(sp);
  }

  // Library imports keep EXIF → live-GPS fallback; caption starts empty. Each is streamed on its own.
  async function addAssets(assets: ImagePicker.ImagePickerAsset[]) {
    let live: PhotoMetadata | null = null;
    const needsLive = assets.some((a) => !hasCoords(extractExifMetadata(a.exif as Record<string, unknown>)));
    if (needsLive) live = await getLiveGps();

    for (const asset of assets) {
      const exifMeta = extractExifMetadata(asset.exif as Record<string, unknown>);
      const metadata: PhotoMetadata = hasCoords(exifMeta)
        ? exifMeta
        : { ...(live ?? {}), takenAt: exifMeta.takenAt ?? live?.takenAt ?? new Date().toISOString() };
      await streamPhoto({
        key: nextKey(),
        clientUploadId: newClientUploadId(),
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        metadata,
        caption: "",
      });
    }
  }

  async function importPhotos() {
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

  function openCamera() {
    setNotice(null);
    cameraGpsRef.current = null;
    cameraGpsSessionRef.current = null;
    setSessionShots([]);
    const session = (cameraSessionRef.current += 1);
    const gpsPromise = getLiveGps();
    cameraGpsPromiseRef.current = gpsPromise;
    void gpsPromise.then((m) => {
      // Drop a fix from a previous camera session (reopened before this resolved)
      // so it can't overwrite cameraGpsRef for the new session.
      if (cameraSessionRef.current !== session) return;
      cameraGpsRef.current = m;
      cameraGpsSessionRef.current = session;
    });
    setCameraOpen(true);
  }

  // Each "Save & Next" streams the shot straight to the durable queue — no review tray, no upload step.
  async function onCameraCapture(shot: CapturedShot, caption: string) {
    const key = nextKey();
    const exifMeta = extractExifMetadata(shot.exif);
    // Honor the shot's own EXIF (DateTimeOriginal + any embedded GPS) first; else the live session GPS.
    // Fall back to the shutter timestamp (always stamped at capture), not commit-time now().
    const takenAt = exifMeta.takenAt ?? shot.capturedAt;
    const session = cameraSessionRef.current;
    setSessionShots((prev) => [...prev, { key, uri: shot.uri }]);

    let metadata: PhotoMetadata;
    if (hasCoords(exifMeta)) {
      metadata = { ...exifMeta, takenAt };
    } else if (cameraGpsRef.current && hasCoords(cameraGpsRef.current)) {
      metadata = { ...cameraGpsRef.current, takenAt };
    } else if (cameraGpsPromiseRef.current) {
      // The shot is already captured; wait for the in-flight fix (best-effort, off the shutter) so the
      // streamed upload is still geotagged. A fix that resolves for a DIFFERENT session is ignored.
      try {
        const m = await cameraGpsPromiseRef.current;
        metadata = cameraSessionRef.current === session && hasCoords(m) ? { ...m, takenAt } : { takenAt };
      } catch {
        metadata = { takenAt };
      }
    } else {
      metadata = { takenAt };
    }

    await streamPhoto({
      key,
      clientUploadId: newClientUploadId(),
      uri: shot.uri,
      width: shot.width,
      height: shot.height,
      metadata,
      caption,
      cameraSession: session,
    });
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

  function clearTarget() {
    setTarget(null);
    router.setParams({ dealId: "", targetName: "", projectNumber: "", stage: "", propertyAddress: "" });
  }

  const pending = pendingQuery.data?.photos ?? [];

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
              <Pressable onPress={clearTarget} hitSlop={12} accessibilityLabel="Clear project">
                <Text style={styles.link}>Clear</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setPickerOpen(true)} hitSlop={12}>
              <Text style={styles.link}>{target ? "Change" : "Choose"}</Text>
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

        {/* Live upload status — photos stream to the durable queue as you capture; this reflects the drain.
            Actively draining → a spinner; stalled with a backlog (e.g. offline) → a Retry (it auto-retries
            in the background too). */}
        {draining ? (
          <View style={styles.uploadingRow}>
            <ActivityIndicator size="small" color={theme.color.brandRed} />
            <Text style={styles.hint}>Uploading…</Text>
          </View>
        ) : queuedCount > 0 ? (
          <View style={styles.uploadingRow}>
            <Text style={styles.hint}>
              {queuedCount} photo{queuedCount === 1 ? "" : "s"} waiting to upload — they'll keep retrying.
            </Text>
            <Pressable onPress={() => void kickDrain()} hitSlop={12} accessibilityLabel="Retry upload now">
              <Text style={styles.link}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Shots that couldn't be written to the durable queue at all (storage full / signed out). Held in
            memory only — retrying re-attempts the enqueue before the temp file can be reclaimed. */}
        {failedShots.length > 0 ? (
          <Banner
            message={`${failedShots.length} photo${failedShots.length === 1 ? "" : "s"} couldn't be saved to the upload queue.`}
            tone="error"
            action={{ label: "Retry", onPress: () => void retryFailedShots() }}
          />
        ) : null}

        {/* Terminal failures: items that exhausted their retries. Not retried automatically — the user can
            dismiss them so they stop occupying the queue. */}
        {failedCount > 0 ? (
          <Banner
            message={`${failedCount} photo${failedCount === 1 ? "" : "s"} couldn't be uploaded after several tries.`}
            tone="error"
            action={{ label: "Dismiss", onPress: () => void dismissFailedUploads() }}
          />
        ) : null}

        {/* Camera mode — per-photo (caption each shot) vs. batch (fast burst, no caption prompt) */}
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
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${label} camera mode`}
                  style={[styles.segBtn, active && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, active && styles.segTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Category + tags are stamped onto every photo you take NEXT — set them before shooting. */}
        <View style={{ gap: theme.space.xs }}>
          <Text style={styles.fieldLabel}>Category</Text>
          <Text style={styles.hint}>Applied to every photo you capture next.</Text>
          <CategoryPicker value={category} onChange={setCategory} />
        </View>
        <View style={{ gap: theme.space.xs }}>
          <Text style={styles.fieldLabel}>Tags</Text>
          <PhotoTagInput tags={tags} onChange={setTags} dealId={target?.type === "deal" ? target.id : undefined} />
        </View>

        {/* Capture actions — every shot uploads immediately, no separate upload step. */}
        <View style={styles.actions}>
          <Button
            title="Open camera"
            icon={<Ionicons name="camera" size={18} color={theme.color.textInverse} />}
            onPress={openCamera}
            accessibilityLabel="Open camera"
            style={{ flex: 1 }}
          />
          <Button
            title="Import"
            variant="ghost"
            icon={<Ionicons name="images-outline" size={18} color={theme.color.textPrimary} />}
            onPress={importPhotos}
            accessibilityLabel="Import photos"
            style={{ flex: 1 }}
          />
        </View>

        {queuedCount === 0 && !draining && failedShots.length === 0 && pending.length === 0 ? (
          <View style={styles.emptyWrap}>
            <EmptyState
              title={target ? "Ready to capture" : "No project selected"}
              subtitle={
                target
                  ? `Every photo uploads to ${target.name} the moment you take it.`
                  : "Choose a project above, or shoot now — photos upload to Pending and you can assign them after."
              }
            />
          </View>
        ) : null}

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
            count={sessionShots.length}
            recent={sessionShots.slice(-5).map((p) => p.uri)}
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
  // flexGrow lets the "Ready to capture" empty state center in the leftover space.
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
  targetActions: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  uploadingRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
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
