import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
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
import { type CaptureTargetRef, type CaptureUploadInput } from "../../src/capture/upload";
import {
  clearFailedUploads,
  drainUploadQueue,
  enqueueUploads,
  getFailedCount,
  getQueuedCount,
  getQueuedUploads,
  newClientUploadId,
  patchQueuedMetadata,
  uploadOwnerKey,
} from "../../src/capture/upload-queue";
import { clearDraft, loadDraft, removeDraftPhotos, stageDraftPhoto, updateDraftCaption, type StagedDraftItem } from "../../src/capture/review-draft";
import { registerUploadBackgroundTask } from "../../src/capture/upload-background-task";
import { buildCaptureUploadInput, setPhotoCaption, appendPhotoCaption, removePhoto, type SessionPhoto } from "../../src/capture/session-photo";
import type { CapturedShot } from "../../src/capture/CameraCapture";
import { DEFAULT_CAPTURE_MODE, loadCaptureMode, saveCaptureMode, type CaptureMode } from "../../src/capture/capture-mode";
import { Badge, Button, EmptyState } from "../../src/components/ui";
import { Banner } from "../../src/components/Banner";
import { CategoryPicker } from "../../src/components/CategoryPicker";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { PhotoTagInput } from "../../src/components/PhotoTagInput";
import { TargetPicker } from "../../src/components/TargetPicker";
import { ReviewTray } from "../../src/components/ReviewTray";

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

// Rehydrate a recovered draft item back into a SessionPhoto for the crash-recovery enqueue. No cameraSession:
// at recovery there's no live camera session to reconcile GPS against, so it's treated like a library import
// (its metadata — coords baked in at capture, if any — is uploaded as-is).
function draftItemToSessionPhoto(it: StagedDraftItem): SessionPhoto {
  return {
    key: it.key,
    clientUploadId: it.clientUploadId,
    uri: it.uri,
    width: it.width,
    height: it.height,
    metadata: it.metadata,
    caption: it.caption,
  };
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
  // Each is BOUND to the ownerKey that captured it (+ its fully-resolved capture-time upload input), so one
  // account can never retry another's photo and a retry never re-binds to a project selected later.
  const [failedShots, setFailedShots] = useState<{ ownerKey: string; input: CaptureUploadInput }[]>([]);
  const failedShotsRef = useRef<{ ownerKey: string; input: CaptureUploadInput }[]>([]);
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
  // Read the LIVE mode inside the camera's per-shot handler (a stale closure could misroute a shot
  // between the immediate-stream and batch-buffer paths).
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  // Photos captured in a camera BATCH session, held until the camera closes and the review step opens.
  // (Per-photo camera mode streams as it shoots and never fills this.) Mirrored to a ref so the Done/close
  // handler reads the latest buffer without a stale closure.
  const [cameraBatch, setCameraBatch] = useState<SessionPhoto[]>([]);
  const cameraBatchRef = useRef<SessionPhoto[]>([]);
  useEffect(() => { cameraBatchRef.current = cameraBatch; }, [cameraBatch]);
  // The per-photo caption REVIEW step: a library import OR a finished camera batch lands here as
  // SessionPhoto[] so each photo gets its OWN optional caption before anything uploads. `reviewCtx` is the
  // capture-time destination snapshot streamed with every photo on Done. Empty list = review closed.
  const [reviewPhotos, setReviewPhotos] = useState<SessionPhoto[]>([]);
  const [reviewCtx, setReviewCtx] = useState<{ target: CaptureTargetRef; category: string | null; tags: string[] } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  // True while a caption-sheet VoiceRecorder is recording/transcribing — disables the review footer
  // Upload/Cancel so a tap can't stream the caption before the in-flight transcript is appended (lost note).
  const [reviewVoiceBusy, setReviewVoiceBusy] = useState(false);
  // Mirror "a review is open" into a ref so the mount/foreground resume path can decide — WITHOUT racing
  // React state — whether it's safe to recover an ORPHANED review draft: enqueuing the draft while a review
  // is open would ship the ACTIVE review's staged photos before the crew finishes captioning. Kept in sync
  // below. (Also gates Cancel: clearing the draft BEFORE the review state means reviewOpenRef must still be
  // true during the delete so a concurrent resume can't recover the very draft Cancel is discarding.)
  const reviewOpenRef = useRef(false);
  useEffect(() => { reviewOpenRef.current = reviewPhotos.length > 0; }, [reviewPhotos.length]);
  // Mirror the camera-open state too: during a camera-BATCH session the shots are staged to the draft but the
  // review modal isn't open yet, so reviewOpenRef alone wouldn't protect them from the draft-recovery below.
  // A KILL still recovers — a fresh mount has the camera closed, so an orphan draft recovers then.
  const cameraOpenRef = useRef(false);
  useEffect(() => { cameraOpenRef.current = cameraOpen; }, [cameraOpen]);
  // Mirror reviewPhotos so a functional caption edit can compute the resulting caption to PERSIST onto the
  // durable draft (best-effort — a crash preserves captions typed so far) without a stale closure.
  const reviewPhotosRef = useRef<SessionPhoto[]>([]);
  useEffect(() => { reviewPhotosRef.current = reviewPhotos; }, [reviewPhotos]);
  const keyCounter = useRef(0);
  // Live GPS fetched once per camera session so burst shots aren't each blocked
  // on a fresh fix (a burst is at one location); applied to every shot.
  const cameraGpsRef = useRef<PhotoMetadata | null>(null);
  // Monotonic camera-session token: a late getLiveGps() from a PRIOR session (the
  // user reopened the camera before it resolved) must not overwrite the current session.
  const cameraSessionRef = useRef(0);
  // The camera session cameraGpsRef belongs to — scopes upload-time reconciliation
  // so a later session's fix can't geotag an earlier session's shot.
  const cameraGpsSessionRef = useRef<number | null>(null);
  // clientUploadIds streamed coordless (captured before this session's GPS fix landed), tagged by session.
  // When the fix resolves, their durable queue entries are patched with the coordinates (best-effort).
  const pendingGpsRef = useRef<{ clientUploadId: string; session: number }[]>([]);

  // Mirror target/category/tags into refs so the capture handlers can read the LIVE value (not a stale
  // closure) at the shutter — the snapshot they take there is what each streamed photo is stamped with.
  const targetStateRef = useRef(target);
  const categoryRef = useRef(category);
  const tagsRef = useRef(tags);
  useEffect(() => { targetStateRef.current = target; }, [target]);
  useEffect(() => { categoryRef.current = category; }, [category]);
  useEffect(() => { tagsRef.current = tags; }, [tags]);
  // The LIVE owner (user + resolved office), read after any `await` that stages photos so an office switch /
  // sign-out mid-await can't restage the prior owner's local photos under the CURRENT owner (upload uses the
  // current ownerKey). A closure's `ownerKey` is the render-time value; this ref sees the change.
  const ownerKeyRef = useRef(ownerKey);
  useEffect(() => { ownerKeyRef.current = ownerKey; }, [ownerKey]);

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
  // Synchronous latch so a same-frame double-tap of "Upload" can't run finishReview twice over the same
  // reviewPhotos snapshot (setReviewBusy(true) only takes effect on the next render).
  const finishingRef = useRef(false);
  // In-flight review-draft staging promises (each = a file copy + manifest append). Import and camera-batch
  // stage fire-and-forget (CameraCapture doesn't await onCapture); Done AWAITS these before enqueuing so the
  // async copy can never race the enqueue and drop a photo. Each promise removes itself from the LIVE ref on
  // settle, so an owner switch that resets the set doesn't strand a stale entry.
  const stagingPromisesRef = useRef<Set<Promise<unknown>>>(new Set());
  const trackStaging = useCallback((p: Promise<unknown>) => {
    stagingPromisesRef.current.add(p);
    void Promise.resolve(p)
      .catch(() => undefined)
      .finally(() => stagingPromisesRef.current.delete(p));
  }, []);
  const awaitStaging = useCallback(async () => {
    // Loop: a stage in flight when we start could (in theory) spawn another before it settles; keep draining
    // until the set is empty so Done never enqueues before every durable copy + manifest write has landed.
    while (stagingPromisesRef.current.size > 0) {
      await Promise.allSettled([...stagingPromisesRef.current]);
    }
  }, []);
  // While offline, auto-drains fired after each shot are suppressed until this timestamp — otherwise every
  // capture would re-attempt the whole backlog and burn a retry on each queued item (they go terminal after
  // MAX_UPLOAD_ATTEMPTS). Lifecycle/user triggers (foreground, manual Retry, owner resume) force through it.
  const drainBackoffUntilRef = useRef(0);
  // Reset the coalescer + backoff when the owner changes so nothing carries across a user/office switch.
  useEffect(() => {
    drainingRef.current = false;
    redrainRef.current = false;
    drainBackoffUntilRef.current = 0;
    // Security: buffered shots are bound to the owner that captured them — drop any from a DIFFERENT
    // authenticated owner (user/office) so one account can never retry a prior account's photo. Ownerless
    // shots (captured during a transient sign-out — no authenticated owner) are KEPT so the next signer can
    // claim + retry them; they are never another authenticated user's photo.
    setFailedShots((prev) => prev.filter((f) => f.ownerKey === ownerKey || f.ownerKey === ""));
    // Staged review/batch photos live in the PREVIOUS owner's durable review DRAFT (per-owner dir) and are
    // safely recovered when that owner signs back in — so here we just drop the in-memory review state + the
    // in-flight staging tracker; the next account can never see or upload the prior owner's staged shots.
    setReviewPhotos([]);
    setReviewCtx(null);
    setReviewVoiceBusy(false);
    stagingPromisesRef.current = new Set();
    setCameraBatch([]);
    cameraBatchRef.current = [];
  }, [ownerKey]);
  const kickDrain = useCallback(
    async (force = false) => {
      if (!ownerKey) return;
      if (!force && Date.now() < drainBackoffUntilRef.current) return;
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
            if (summary.succeeded > 0) {
              drainBackoffUntilRef.current = 0; // made progress — clear any backoff
            } else if (summary.remaining > 0) {
              // Nothing got through but items remain (offline/stuck). drainUploadQueue reports upload
              // failures via the summary rather than throwing, so back off HERE — otherwise every offline
              // shot would re-attempt the whole backlog and drive queued items to terminal. Lifecycle/user
              // triggers force through; the background task + foreground resume retry later.
              drainBackoffUntilRef.current = Date.now() + 30_000;
              break;
            }
          } catch {
            remaining = await getQueuedCount(ownerKey).catch(() => remaining);
            drainBackoffUntilRef.current = Date.now() + 30_000;
            break;
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
    },
    [ownerKey, queueFetcher, refreshQueuedCount, pendingQuery],
  );

  // Enqueue ONE reviewed/recovered draft photo into the NORMAL (non-held) upload queue, mirroring streamPhoto's
  // GPS handling: reconcile the session fix into the built input, and register a still-coordless CAMERA shot in
  // pendingGpsRef so a late fix patches its queued row (imports/recovered items have no cameraSession → never
  // registered). A per-photo enqueue failure PARKS the shot in failedShots (bound to its owner) so it's never
  // lost. Returns true iff it enqueued. Stable (reads only refs + stable setters), so both Done and the
  // crash-recovery resume can call it.
  const enqueueReviewPhoto = useCallback(
    async (
      owner: string,
      photo: SessionPhoto,
      ctx: { target: CaptureTargetRef; category: string | null; tags: string[] },
    ): Promise<boolean> => {
      const input = buildCaptureUploadInput(photo, {
        target: ctx.target,
        category: ctx.category,
        tags: ctx.tags,
        sessionGps: cameraGpsRef.current,
        gpsSession: cameraGpsSessionRef.current,
      });
      if (input.metadata.latitude === undefined && photo.cameraSession !== undefined) {
        pendingGpsRef.current.push({ clientUploadId: input.clientUploadId, session: photo.cameraSession });
      }
      const park = () =>
        setFailedShots((prev) =>
          prev.some((f) => f.input.clientUploadId === input.clientUploadId) ? prev : [...prev, { ownerKey: owner, input }],
        );
      if (!owner) {
        park();
        return false;
      }
      try {
        await enqueueUploads(owner, [input]);
        return true;
      } catch {
        park();
        return false;
      }
    },
    [],
  );

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
      // Crash recovery for the review-draft store: a crash/kill mid-review (or mid-batch) leaves staged photos
      // in the durable DRAFT, never enqueued. With NO review open AND the camera closed they are orphans (their
      // session died before Done), so enqueue them — WITH their persisted captions — into the upload queue and
      // clear the draft, so photos + typed captions survive the crash. NEVER recover while a review OR the
      // camera is open (that would enqueue the ACTIVE session's staged photos before the crew finishes — a
      // background→foreground mid-batch is not a crash). A real kill still recovers: a fresh mount has both
      // closed. Runs BEFORE the count so getQueuedCount sees the freshly-enqueued rows.
      if (!reviewOpenRef.current && !cameraOpenRef.current) {
        try {
          const orphans = await loadDraft(ownerKey);
          if (orphans.length > 0) {
            for (const it of orphans) await enqueueReviewPhoto(ownerKey, draftItemToSessionPhoto(it), it.ctx);
            await clearDraft(ownerKey).catch(() => undefined);
          }
        } catch {
          /* best-effort — the draft stays for the next resume */
        }
      }
      const [n, failed] = await Promise.all([getQueuedCount(ownerKey), getFailedCount(ownerKey)]);
      if (cancelled) return;
      setQueuedCount(n);
      setFailedCount(failed);
      if (n > 0) void kickDrainRef.current(true);
    };
    void resumeIfQueued();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void resumeIfQueued();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [ownerKey, enqueueReviewPhoto]);

  // Persist one captured/imported photo to the durable queue (stamping the CURRENT target, category, and
  // tags via refs), then kick the background drain — no separate "upload" step. Once enqueueUploads resolves
  // the photo is durable (survives crash/kill/connection drop). A capture that can't be persisted (storage
  // full, or a transient sign-out clearing ownerKey) is NEVER dropped: it's kept in the failedShots retry
  // buffer and drops off the session counter, with a sticky error, so a real photo can't vanish silently.
  const streamPhoto = useCallback(
    async (sp: SessionPhoto, ctx: { target: CaptureTargetRef; category: string | null; tags: string[] }) => {
      // Build the FULL upload payload from the CAPTURE-TIME context snapshot the caller passes (never live
      // refs), so a shot enqueued after the crew switched projects — or buffered and retried later — uploads
      // to the destination it was captured for.
      const input = buildCaptureUploadInput(sp, {
        target: ctx.target,
        category: ctx.category,
        tags: ctx.tags,
        sessionGps: cameraGpsRef.current,
        gpsSession: cameraGpsSessionRef.current,
      });
      const retain = () => {
        setSessionShots((prev) => prev.filter((s) => s.key !== sp.key));
        setFailedShots((prev) =>
          prev.some((f) => f.input.clientUploadId === input.clientUploadId) ? prev : [...prev, { ownerKey, input }],
        );
        setNotice({ tone: "error", text: "Some photos couldn't be saved yet — tap Retry to try again." });
      };
      if (!ownerKey) {
        retain();
        return;
      }
      try {
        await enqueueUploads(ownerKey, [input]);
      } catch {
        retain();
        return;
      }
      // Enqueued OK — clear it from the retry buffer if a prior attempt had parked it there.
      setFailedShots((prev) => prev.filter((f) => f.input.clientUploadId !== input.clientUploadId));
      await refreshQueuedCount();
      void kickDrain();
    },
    [ownerKey, refreshQueuedCount, kickDrain],
  );

  // Re-attempt the buffered shots — but ONLY those captured under the CURRENT owner, replaying their stored
  // capture-time payload (not the live target/tags). A shot that fails again is re-buffered under its owner.
  async function retryFailedShots() {
    if (!ownerKey) {
      setNotice({ tone: "error", text: "Sign in again before retrying failed photos." });
      return;
    }
    // Current owner's shots + ownerless ones captured during a transient sign-out (claimed under the now-
    // signed-in owner). A different authenticated owner's shots were already dropped by the owner-change effect.
    const claimable = (f: { ownerKey: string }) => f.ownerKey === ownerKey || f.ownerKey === "";
    const mine = failedShotsRef.current.filter(claimable);
    if (mine.length === 0) return;
    setNotice(null);
    setFailedShots((prev) => prev.filter((f) => !claimable(f)));
    let anyFailed = false;
    for (const f of mine) {
      try {
        await enqueueUploads(ownerKey, [f.input]);
      } catch {
        anyFailed = true;
        setFailedShots((prev) =>
          prev.some((x) => x.input.clientUploadId === f.input.clientUploadId) ? prev : [...prev, f],
        );
      }
    }
    await refreshQueuedCount();
    if (anyFailed) setNotice({ tone: "error", text: "Some photos still couldn't be saved — tap Retry to try again." });
    void kickDrain(true);
  }

  // Library imports keep EXIF → live-GPS fallback; caption starts empty. Instead of streaming immediately,
  // the whole selection is STAGED INTO THE DURABLE REVIEW DRAFT (a store separate from the upload queue) so
  // each photo can get its OWN optional caption before anything uploads. On Done each is enqueued into the
  // normal queue with its own caption; nothing touches the queue/drain until then.
  async function addAssets(assets: ImagePicker.ImagePickerAsset[]) {
    // Snapshot the destination NOW — before the awaited getLiveGps — so a project switch during/after the
    // picker can't retarget the import.
    const ctx = { target: targetRef(targetStateRef.current), category: categoryRef.current, tags: tagsRef.current };
    // Capture the owner at the START. If it changes during the awaited getLiveGps (office switch / sign-out),
    // ABORT and drop the import: the owner-change effect already cleared staged state, and staging under the
    // NEW owner would upload these photos under the wrong account/office — a cross-account/office disclosure.
    const capturedOwner = ownerKey;
    let live: PhotoMetadata | null = null;
    const needsLive = assets.some((a) => !hasCoords(extractExifMetadata(a.exif as Record<string, unknown>)));
    if (needsLive) live = await getLiveGps();
    if (ownerKeyRef.current !== capturedOwner) return;

    const photos: SessionPhoto[] = assets.map((asset) => {
      const exifMeta = extractExifMetadata(asset.exif as Record<string, unknown>);
      const metadata: PhotoMetadata = hasCoords(exifMeta)
        ? exifMeta
        : { ...(live ?? {}), takenAt: exifMeta.takenAt ?? live?.takenAt ?? new Date().toISOString() };
      return {
        key: nextKey(),
        clientUploadId: newClientUploadId(),
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        metadata,
        caption: "",
      };
    });
    if (photos.length === 0) return;
    // Stage each photo into the durable review DRAFT — fire-and-forget + tracked so Done can await the copies
    // (the copy makes it survive a crash before Done). A per-photo stage failure is isolated inside
    // stageDraftPhoto's rejection; the raw uri still rides in reviewPhotos, so Done enqueues it either way.
    // Bound to the re-checked capturedOwner so the draft lives under the owner that started the import.
    for (const p of photos) trackStaging(stageDraftPhoto(capturedOwner, p, ctx));
    openReview(photos, ctx);
  }

  // Open the per-photo review step. PURE UI: the photos were already staged into the durable review DRAFT at
  // their SOURCE (import → addAssets before this call; camera batch → per-shot at capture). Showing the modal
  // does NO enqueue — staged photos never enter the upload queue until Done. A crash mid-review recovers them
  // (with captions typed so far) from the draft on the next launch (see resumeIfQueued).
  function openReview(photos: SessionPhoto[], ctx: { target: CaptureTargetRef; category: string | null; tags: string[] }) {
    setReviewCtx(ctx);
    setReviewPhotos(photos);
  }

  function setReviewCaption(key: string, text: string) {
    setReviewPhotos((prev) => setPhotoCaption(prev, key, text));
    // Persist onto the durable draft too, so a crash preserves the caption typed so far (best-effort).
    if (ownerKey) void updateDraftCaption(ownerKey, key, text).catch(() => undefined);
  }
  // Functional append so rapid (voice) transcripts don't clobber each other.
  function appendReviewCaption(key: string, text: string) {
    setReviewPhotos((prev) => appendPhotoCaption(prev, key, text));
    // Compute the appended value from the last-committed captions (ref) to persist it onto the draft — the
    // same rule as appendPhotoCaption. Best-effort/debounced: the authoritative caption at Done is local state.
    if (ownerKey) {
      const cur = reviewPhotosRef.current.find((p) => p.key === key)?.caption ?? "";
      const next = cur ? `${cur} ${text}` : text;
      void updateDraftCaption(ownerKey, key, next).catch(() => undefined);
    }
  }
  // Removing a staged photo drops it from the durable DRAFT (manifest + its copied file) and the local review
  // set — so a photo pulled out of the tray is never enqueued on Done or recovered on a crash.
  async function removeReviewPhoto(key: string) {
    setReviewPhotos((prev) => removePhoto(prev, key));
    if (ownerKey) await removeDraftPhotos(ownerKey, [key]).catch(() => undefined);
  }
  // Cancel: DISCARD the durable draft, then clear the review UI. Order is load-bearing — reviewOpenRef (from
  // reviewPhotos) gates crash-recovery, so we delete the draft FIRST (while it still reads "review open") so a
  // concurrent foreground-resume can't recover + upload the very photos we're discarding. On a delete FAILURE
  // keep the review OPEN so Cancel can be retried — clearing state would strand recoverable files that a later
  // resume would auto-upload. Await in-flight staging first so a mid-copy shot can't re-create the draft after
  // the delete.
  async function cancelReview() {
    if (reviewBusy || reviewVoiceBusy) return;
    const owner = ownerKey;
    if (owner) {
      setReviewBusy(true);
      try {
        await awaitStaging();
        await clearDraft(owner);
      } catch {
        setNotice({ tone: "error", text: "Couldn't discard those photos — tap Cancel to try again." });
        setReviewBusy(false);
        return;
      }
      setReviewBusy(false);
    }
    setReviewPhotos([]);
    setReviewCtx(null);
    setReviewVoiceBusy(false);
  }
  // Done: staged photos are in the durable DRAFT (never the queue yet). AWAIT any in-flight staging, then
  // enqueue each into the NORMAL queue — from the durable draft copy (keyed by session key) when present (a
  // raw in-session uri may have been reclaimed), carrying the caption from the review's LOCAL state (the
  // authoritative value; updateDraftCaption is best-effort). Force ONE drain, then delete the draft. A
  // per-photo enqueue failure PARKS the shot in failedShots (via enqueueReviewPhoto) so it's never lost.
  async function finishReview() {
    if (reviewBusy || reviewVoiceBusy || finishingRef.current) return;
    const photos = reviewPhotos;
    const ctx = reviewCtx;
    const owner = ownerKey;
    if (!ctx || photos.length === 0) {
      setReviewPhotos([]);
      setReviewCtx(null);
      setReviewVoiceBusy(false);
      return;
    }
    finishingRef.current = true;
    setReviewBusy(true);
    try {
      // 1) Await every in-flight draft copy + manifest write (fixes the async-copy race: CameraCapture does
      //    not await onCapture) so the durable draft is complete before we read/enqueue from it.
      await awaitStaging();
      // 2) Enqueue each reviewed photo from its durable copy, with its own caption.
      const durable = owner ? await loadDraft(owner).catch(() => [] as StagedDraftItem[]) : [];
      const byKey = new Map(durable.map((d) => [d.key, d]));
      let anyFailed = false;
      for (const p of photos) {
        const d = byKey.get(p.key);
        const source: SessionPhoto = d ? { ...p, uri: d.uri } : p;
        if (!(await enqueueReviewPhoto(owner, source, ctx))) anyFailed = true;
      }
      await refreshQueuedCount();
      // 3) Force a drain (bypass any offline backoff) so the just-enqueued photos ship now.
      void kickDrain(true);
      // 4) Draft fully consumed → delete it. Best-effort: a failed delete is harmless — a leftover draft is
      //    re-enqueued on the next recovery and the server dedupes on clientUploadId, so no duplicate ships.
      if (owner) await clearDraft(owner).catch(() => undefined);
      // 5) Close the review.
      setReviewVoiceBusy(false);
      setReviewPhotos([]);
      setReviewCtx(null);
      if (anyFailed) setNotice({ tone: "error", text: "Some photos couldn't be saved yet — tap Retry to try again." });
    } finally {
      finishingRef.current = false;
      setReviewBusy(false);
    }
  }

  async function importPhotos() {
    if (!ownerKey) {
      setNotice({ tone: "error", text: "Sign in again to import photos." });
      return;
    }
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
    if (!ownerKey) {
      setNotice({ tone: "error", text: "Sign in again to capture photos." });
      return;
    }
    setNotice(null);
    cameraGpsRef.current = null;
    cameraGpsSessionRef.current = null;
    setSessionShots([]);
    setCameraBatch([]);
    cameraBatchRef.current = [];
    const session = (cameraSessionRef.current += 1);
    const owner = ownerKey;
    void getLiveGps().then(async (m) => {
      const withCoords = hasCoords(m);
      // Adopt the fix as the live session GPS only if THIS is still the active session (don't clobber a
      // newer session's ref). getLiveGps always resolves (coordless on denial/timeout), so this runs once.
      if (cameraSessionRef.current === session && withCoords) {
        cameraGpsRef.current = m;
        cameraGpsSessionRef.current = session;
      }
      // Best-effort geotag: patch coords onto THIS session's still-queued coordless shots. Shots are NEVER
      // held back for GPS — they enqueue + drain immediately (durability + no stranding), so some may have
      // already uploaded; those are simply skipped. Always clear this session's pending ids.
      const ids = pendingGpsRef.current.filter((p) => p.session === session).map((p) => p.clientUploadId);
      pendingGpsRef.current = pendingGpsRef.current.filter((p) => p.session !== session);
      if (!withCoords || ids.length === 0) return;
      const patched = await Promise.all(
        ids.map((id) =>
          patchQueuedMetadata(owner, id, { latitude: m.latitude!, longitude: m.longitude!, addressSource: m.addressSource }).catch(() => false),
        ),
      );
      // If any still-queued shot got geotagged, drain so it uploads WITH coords now instead of on the next trigger.
      if (patched.some(Boolean)) void kickDrain();
    });
    setCameraOpen(true);
  }

  // Per-photo camera mode: each "Save & Next" streams the shot straight to the durable queue — no review
  // tray, no upload step. The shot is enqueued IMMEDIATELY (never waits on the GPS fix); if it has no coords
  // yet, its queue entry is patched when the session fix lands (openCamera's .then). Durability first, geotag
  // best-effort. BATCH mode instead STAGES the shot into the durable review DRAFT (captioned there, enqueued
  // on Done) — so a fast burst still gets an optional per-photo caption without slowing the shutter, and the
  // shot never touches the upload queue / drain until Done.
  async function onCameraCapture(shot: CapturedShot, caption: string) {
    const key = nextKey();
    const exifMeta = extractExifMetadata(shot.exif);
    // Honor the shot's own EXIF (DateTimeOriginal + any embedded GPS) first; else the resolved session fix.
    // Fall back to the shutter timestamp (always stamped at capture), not commit-time now().
    const takenAt = exifMeta.takenAt ?? shot.capturedAt;
    const session = cameraSessionRef.current;
    const clientUploadId = newClientUploadId();
    const batchMode = modeRef.current === "batch";
    setSessionShots((prev) => [...prev, { key, uri: shot.uri }]);

    let metadata: PhotoMetadata;
    let coordless = false;
    if (hasCoords(exifMeta)) {
      metadata = { ...exifMeta, takenAt };
    } else if (cameraGpsRef.current && hasCoords(cameraGpsRef.current)) {
      metadata = { ...cameraGpsRef.current, takenAt };
    } else {
      // No coords yet. A per-photo shot enqueues NOW, so it registers in pendingGpsRef here (below) so the
      // session fix patches its queued row. A BATCH shot isn't queued until Done, so enqueueReviewPhoto
      // registers it THEN — registering here would point the late fix at a not-yet-queued row.
      metadata = { takenAt };
      coordless = true;
    }

    const sp: SessionPhoto = { key, clientUploadId, uri: shot.uri, width: shot.width, height: shot.height, metadata, caption, cameraSession: session };

    if (batchMode) {
      // Update the ref SYNCHRONOUSLY (before any await) so a Done tapped in the same frame as the shutter
      // can't have closeCamera read a stale batch and drop this shot. Read from the ref too, so rapid shots
      // each append to the latest.
      const nextBatch = [...cameraBatchRef.current, sp];
      cameraBatchRef.current = nextBatch;
      setCameraBatch(nextBatch);
      // Stage the shot into the durable review DRAFT (NOT the upload queue) — durable from the shutter (a
      // crash before Done recovers it) but it never touches the drain/backoff until Done. Fire-and-forget +
      // tracked so Done can await the copy. The camera covers the screen, so target/category/tags can't
      // change mid-session — this shutter-time ctx equals the Done-time ctx closeCamera hands to the review.
      const ctx = { target: targetRef(targetStateRef.current), category: categoryRef.current, tags: tagsRef.current };
      trackStaging(stageDraftPhoto(ownerKey, sp, ctx));
      return;
    }

    // Per-photo: enqueue immediately. Register a coordless shot NOW (it's queued now) so the session fix
    // patches its queued row. Snapshot the destination at the shutter so a later switch can't retarget it.
    if (coordless) pendingGpsRef.current.push({ clientUploadId, session });
    const ctx = { target: targetRef(targetStateRef.current), category: categoryRef.current, tags: tagsRef.current };
    await streamPhoto(sp, ctx);
  }

  // Camera closed (Done). If a batch was captured, hand it to the per-photo review step. The batch shots are
  // ALREADY staged into the durable review DRAFT (at each shutter in onCameraCapture), so openReview only
  // shows the modal — NO enqueue (staged photos enter the upload queue only on Done). (ctx snapshot now — the
  // camera covered the screen so it couldn't have changed mid-capture — equals each shot's shutter-time ctx.)
  function closeCamera() {
    setCameraOpen(false);
    const batch = cameraBatchRef.current;
    if (batch.length > 0) {
      openReview(batch, { target: targetRef(targetStateRef.current), category: categoryRef.current, tags: tagsRef.current });
      setCameraBatch([]);
      cameraBatchRef.current = [];
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
            <Pressable onPress={() => void kickDrain(true)} hitSlop={12} accessibilityLabel="Retry upload now">
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
            onClose={closeCamera}
            count={sessionShots.length}
            recent={sessionShots.slice(-5).map((p) => p.uri)}
            annotatePerShot={mode === "perPhoto"}
            voiceEnabled={transcribeConfig.data?.configured ?? false}
          />
        </Suspense>
      ) : null}

      {/* Per-photo caption review — a library import OR a finished camera batch lands here so each photo
          gets its OWN optional caption before anything uploads. Blank = no description (no shared caption). */}
      <Modal
        visible={reviewPhotos.length > 0}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={cancelReview}
      >
        <SafeAreaProvider>
          <SafeAreaView style={styles.reviewSafe} edges={["top", "bottom"]}>
            <View style={styles.reviewHeader}>
              <Pressable
                onPress={cancelReview}
                disabled={reviewBusy || reviewVoiceBusy}
                hitSlop={12}
                accessibilityLabel="Cancel review"
              >
                <Text style={[styles.link, (reviewBusy || reviewVoiceBusy) && styles.reviewDisabled]}>Cancel</Text>
              </Pressable>
              <Text style={styles.reviewTitle}>Add descriptions</Text>
              <Text style={styles.reviewCount}>
                {reviewPhotos.length} photo{reviewPhotos.length === 1 ? "" : "s"}
              </Text>
            </View>
            <ScrollView
              contentContainerStyle={styles.reviewBody}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
            >
              <Text style={styles.hint}>
                Tap a photo to add an optional description. Photos left blank upload with no description.
              </Text>
              <ReviewTray
                photos={reviewPhotos}
                onSetCaption={setReviewCaption}
                onAppendCaption={appendReviewCaption}
                onRemove={removeReviewPhoto}
                onVoiceBusyChange={setReviewVoiceBusy}
                disabled={reviewBusy}
                voiceEnabled={transcribeConfig.data?.configured ?? false}
              />
            </ScrollView>
            <View style={styles.reviewFooter}>
              <Button
                title={reviewBusy ? "Uploading…" : `Upload ${reviewPhotos.length} photo${reviewPhotos.length === 1 ? "" : "s"}`}
                onPress={() => void finishReview()}
                disabled={reviewBusy || reviewVoiceBusy}
                accessibilityLabel="Upload reviewed photos"
                style={{ flex: 1 }}
              />
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>

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
  reviewSafe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  reviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  reviewTitle: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.textPrimary },
  reviewCount: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.textMuted },
  reviewDisabled: { opacity: 0.4 },
  reviewBody: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  reviewFooter: {
    flexDirection: "row",
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.md,
    paddingBottom: theme.space.sm,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
});
