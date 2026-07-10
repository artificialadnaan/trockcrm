import React, { Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import SignatureScreen from "react-native-signature-canvas";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { getTranscriptionConfig, type Fetcher } from "../../../src/api/endpoints";
import { apiFetch } from "../../../src/api/client";
import { uploadOwnerKey, newClientUploadId, removeQueuedUploads } from "../../../src/capture/upload-queue";
import { qk } from "../../../src/query/keys";
import { extractExifMetadata, getLiveGps, type PhotoMetadata } from "../../../src/capture/metadata";
import type { CapturedShot } from "../../../src/capture/CameraCapture";
import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  scorecardRatingLabel,
} from "../../../src/scorecards/scoring";
import {
  scorecardDraftReducer,
  scorecardDraftTotal,
  scorecardDraftRating,
  scorecardActionItemsRequired,
  scorecardDraftPhotosForSection,
  validateScorecardDraft,
  type ScorecardDraft,
  type ScorecardDraftPhoto,
  type DraftAction,
} from "../../../src/scorecards/draft";
import { loadScorecardDraft, saveScorecardDraft, deleteScorecardDraft, copyPhotoIntoDraft } from "../../../src/scorecards/draft-store";
import { submitScorecard } from "../../../src/scorecards/submit";
import { Badge, Button, EmptyState, LoadingState, SectionLabel, TextInput } from "../../../src/components/ui";
import { Banner } from "../../../src/components/Banner";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { RatingBadge } from "../../../src/components/RatingBadge";
import { VoiceRecorder } from "../../../src/components/VoiceRecorder";
import { PhotoCaptionEditor } from "../../../src/components/PhotoCaptionEditor";

const CameraCapture = React.lazy(() => import("../../../src/capture/CameraCapture"));

const SECTION_COUNT = FIELD_SCORECARD_SECTIONS.length;
// Step 0 is the one-page scorecard. A category opens a focused detail editor at 1..8.
const LAST_STEP = 0;

function toStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

// Server cap on total evidence photos (parseScorecardSubmission rejects photos.length > 100). Mirrored here so
// a multi-select import can't stage a batch that would only fail at submit and force manual removal.
const MAX_SCORECARD_PHOTOS = 100;

// Merge an already-resolved live GPS fix into a shot's EXIF only when the shot itself has no location. Pure, so
// a BATCH import can fetch live GPS ONCE and reuse it across every coordless asset (the per-asset getLiveGps in
// the old fallback serialized up to 8s per photo — minutes on a large indoor import).
function mergeLiveGps(exif: ReturnType<typeof extractExifMetadata>, live: PhotoMetadata | null) {
  if (exif.latitude !== undefined && exif.longitude !== undefined) return exif;
  if (live && live.latitude !== undefined && live.longitude !== undefined) {
    return { ...exif, latitude: live.latitude, longitude: live.longitude, addressSource: live.addressSource ?? exif.addressSource };
  }
  return exif;
}

// Stamp live device GPS when a single shot's EXIF has no location — mirrors the Capture screen, so scorecard
// evidence isn't missing coordinates on devices whose camera omits GPS EXIF. Best-effort; never throws.
async function withLiveGpsFallback(exif: ReturnType<typeof extractExifMetadata>) {
  if (exif.latitude !== undefined && exif.longitude !== undefined) return exif;
  return mergeLiveGps(exif, await getLiveGps().catch(() => null));
}

export default function ScorecardWizardScreen() {
  const router = useRouter();
  const draftId = toStr(useLocalSearchParams<{ draftId: string }>().draftId);
  const { fetcher, user, activeOfficeId, token, signOut } = useAuth();
  const qc = useQueryClient();
  // Bind the queue owner + its drain fetcher to the RESOLVED office (activeOfficeId ?? primary). The
  // AuthContext fetcher omits x-office-id for a primary session, so a re-homed user would otherwise drain
  // an offline draft's photos against their NEW primary office. queueFetcher pins x-office-id to the office
  // the draft was captured under — matching ownerKey + capture.tsx's queueFetcher.
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = uploadOwnerKey(user?.id, resolvedOfficeId ?? undefined);
  const queueFetcher = useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, { ...opts, token: token ?? undefined, officeId: resolvedOfficeId, onUnauthorized: () => void signOut() }),
    [token, resolvedOfficeId, signOut],
  );

  const [loaded, setLoaded] = useState<ScorecardDraft | null | "missing">(null);
  const [step, setStep] = useState(0);
  const [cameraSection, setCameraSection] = useState<number | null>(null);
  const [cameraDeficiency, setCameraDeficiency] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });
  const voiceEnabled = transcribeConfig.data?.configured ?? false;

  useEffect(() => {
    if (!ownerKey || !draftId) return;
    // Reset ALL transient screen state if the screen is reused for a different draftId (deep link /
    // replace) — otherwise the camera overlay, submit spinner, or a stale banner leak across sessions.
    setLoaded(null);
    setStep(0);
    setCameraSection(null);
    setCameraDeficiency(null);
    setSubmitting(false);
    setNotice(null);
    // Guard against a slow load from a PREVIOUS draftId/owner resolving last and seeding the wizard with
    // the wrong draft — ignore any resolution after this effect has been superseded.
    let cancelled = false;
    void loadScorecardDraft(ownerKey, draftId)
      .then((d) => {
        if (!cancelled) setLoaded(d ?? "missing");
      })
      .catch(() => {
        // A read failure must not leave the screen stuck on "Loading…" forever — resolve to the
        // not-found state so the user gets a clear message + a way back.
        if (!cancelled) setLoaded("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [ownerKey, draftId]);

  // Reducer seeded once the draft loads. `key` remounts the reducer host when the draft arrives.
  if (loaded === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Scorecard" />
        <LoadingState label="Loading…" />
      </SafeAreaView>
    );
  }
  if (loaded === "missing") {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Scorecard" />
        <EmptyState title="Draft not found" subtitle="It may have been submitted or deleted." />
      </SafeAreaView>
    );
  }

  return (
    <Wizard
      key={draftId}
      initial={loaded}
      ownerKey={ownerKey!}
      draftId={draftId}
      step={step}
      setStep={setStep}
      cameraSection={cameraSection}
      setCameraSection={setCameraSection}
      cameraDeficiency={cameraDeficiency}
      setCameraDeficiency={setCameraDeficiency}
      submitting={submitting}
      setSubmitting={setSubmitting}
      notice={notice}
      setNotice={setNotice}
      voiceEnabled={voiceEnabled}
      onSubmitted={(dealId) => {
        if (user) {
          void qc.invalidateQueries({ queryKey: ["scorecards-recent", user.id] });
          // Evidence photos were just uploaded into the deal gallery — refresh it too.
          void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, dealId) });
          // …and the project-detail Scorecards section, so the new card appears without a manual refresh.
          void qc.invalidateQueries({ queryKey: qk.projectScorecards(user.id, dealId) });
        }
        router.back();
      }}
      fetcher={queueFetcher}
    />
  );
}

function Wizard(props: {
  initial: ScorecardDraft;
  ownerKey: string;
  draftId: string;
  step: number;
  setStep: (n: number) => void;
  cameraSection: number | null;
  setCameraSection: (n: number | null) => void;
  cameraDeficiency: string | null;
  setCameraDeficiency: (key: string | null) => void;
  submitting: boolean;
  setSubmitting: (b: boolean) => void;
  notice: { tone: "success" | "error"; text: string } | null;
  setNotice: (n: { tone: "success" | "error"; text: string } | null) => void;
  voiceEnabled: boolean;
  onSubmitted: (dealId: string) => void;
  fetcher: ReturnType<typeof useAuth>["fetcher"];
}) {
  const { ownerKey, draftId, step, setStep, cameraSection, setCameraSection, cameraDeficiency, setCameraDeficiency, submitting, setSubmitting, notice, setNotice, voiceEnabled, onSubmitted, fetcher } = props;
  const router = useRouter();
  const [draft, dispatch] = useReducer(scorecardDraftReducer, props.initial);
  // Count of evidence photos still being copied into durable storage. Submit is blocked while > 0 so a
  // capture in flight (durable copy + dispatch not yet done) can't be omitted from a fast submit.
  const [savingPhotos, setSavingPhotos] = useState(0);
  const [captionPhotoKey, setCaptionPhotoKey] = useState<string | null>(null);
  const [captionVoiceBusy, setCaptionVoiceBusy] = useState(false);
  const [signingField, setSigningField] = useState<"superintendentSignature" | "pmSignature" | null>(null);
  // Serialize autosaves so a slow older write can't land after a newer edit — or after the submit-delete
  // and resurrect a submitted draft. `finalized` stops saves once the draft is submitted + deleted.
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const finalized = useRef(false);
  // Synchronous lock for photo imports: `savingPhotos` is React state and doesn't update before a second rapid
  // Import tap re-reads it, so a ref bails the second tap before it opens the picker (see importForSection). It
  // also blocks a camera capture during an import's picker window (before the savingPhotos marker is set).
  const importInFlight = useRef(false);
  // Authoritative synchronous photo count = committed photos + reservations still copying. The 100-photo cap is
  // enforced against THIS ref, never draft.photos.length (reducer state, which lags a rapid next capture/import
  // by a render): every accept reserves a slot here BEFORE its async copy, and a slot is released ONLY if the
  // copy fails or the photo is removed — never on successful commit — so there is no window where an in-flight
  // photo is counted in neither this ref nor draft.photos. Kept in lockstep with the reducer's only two photo
  // mutations (addPhoto / removePhoto). Seeded from the loaded draft (may already hold photos on resume).
  const photoCount = useRef(props.initial.photos.length);
  // Keys whose cap slot has already been released, so a removal is idempotent SYNCHRONOUSLY — a double-tap on a
  // thumbnail's remove button (two onPress before React re-renders) must not decrement photoCount twice for one
  // reducer removal. Keys are globally-unique clientUploadIds that are never reused, so this set only grows by
  // removed photos (bounded by the session's photo count) and never needs pruning.
  const releasedKeys = useRef<Set<string>>(new Set());
  // Ids of removed photos whose queue-cancellation hasn't confirmed yet. onSubmit retries the cancellation
  // for all still-pending ids and only proceeds once it succeeds — a FAILED removal stays in the set (and
  // blocks submit) instead of being cleared, so the drain can never upload evidence the user removed.
  const pendingRemovalIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (finalized.current) return;
    saveChain.current = saveChain.current
      .then(() => (finalized.current ? undefined : saveScorecardDraft(ownerKey, draft, Date.now())))
      .catch(() => undefined);
  }, [draft, ownerKey]);

  const total = scorecardDraftTotal(draft);
  const validation = validateScorecardDraft(draft);
  const captionPhoto = draft.photos.find((photo) => photo.key === captionPhotoKey) ?? null;

  const goNext = () => setStep(Math.min(LAST_STEP, step + 1));
  const goBack = () => {
    // Leaving the wizard (step 0 → router.back) unmounts it; if a photo copy is still in flight, its
    // pending dispatch would be lost (the accepted photo never lands in the draft). Block until it settles.
    // Step-back keeps the screen mounted, so it's always safe.
    if (step === 0) {
      if (savingPhotos > 0) {
        setNotice({ tone: "error", text: "Saving a photo — one moment…" });
        return;
      }
      router.back();
      return;
    }
    setStep(0);
  };

  // Remove a photo from the draft AND cancel any already-queued upload for it (a prior offline submit may
  // have enqueued it) so a later drain can't upload evidence that's no longer part of the card. The
  // cancellation is TRACKED (not fire-and-forget): onSubmit awaits it, so a fast Remove → Submit can't
  // drain the just-removed photo before its queue removal settles, and a failure blocks submit instead of
  // being silently ignored. The queue mutex additionally guarantees this write can't clobber photos a
  // concurrent submit enqueues.
  const removePhotoAndCancelUpload = (photo: ScorecardDraftPhoto) => {
    // Release the photo's cap slot exactly once, keyed on the clientUploadId so a double-tap can't decrement
    // photoCount twice (the reducer's filter is a no-op the second time, so the authoritative count must be too).
    // This is synchronous — it does NOT depend on draft having re-rendered between the two taps.
    if (!releasedKeys.current.has(photo.key)) {
      releasedKeys.current.add(photo.key);
      photoCount.current -= 1;
    }
    dispatch({ type: "removePhoto", key: photo.key });
    const id = photo.clientUploadId;
    pendingRemovalIds.current.add(id);
    // Best-effort now; on success drop it from the pending set. On failure it STAYS pending so onSubmit
    // retries the cancellation before allowing the drain.
    void removeQueuedUploads(ownerKey, [id])
      .then(() => pendingRemovalIds.current.delete(id))
      .catch(() => undefined);
  };

  async function onCameraCapture(shot: CapturedShot, caption: string) {
    if (cameraSection === null) return;
    // Block a capture only while an IMPORT batch is in flight (its picker/live-GPS/copy window) — an import can
    // stage many photos at once that draft.photos doesn't yet reflect. Do NOT block on savingPhotos: a second
    // camera shot taken while the first is still saving is legitimate batch capture, and rejecting it here would
    // silently drop the shot + its note behind the camera modal (the notice stays hidden until Done).
    if (importInFlight.current) {
      setNotice({ tone: "error", text: "Still saving imported photos — try again in a moment." });
      return;
    }
    // Enforce the cap against the authoritative reserved count, not the lagging draft.photos.length — otherwise a
    // shot taken while a prior shot is still copying would read a stale length and could overshoot to 101. Every
    // shot BELOW the cap proceeds (no drop); only the shot that would breach 100 is rejected.
    if (photoCount.current >= MAX_SCORECARD_PHOTOS) {
      setNotice({ tone: "error", text: `A scorecard can hold at most ${MAX_SCORECARD_PHOTOS} photos — remove some to add more.` });
      return;
    }
    const sectionKey = cameraSection === -1 ? "critical_deficiency" : FIELD_SCORECARD_SECTIONS[cameraSection].key;
    const clientUploadId = newClientUploadId();
    photoCount.current += 1; // reserve a slot synchronously; released below only if the copy fails
    setSavingPhotos((n) => n + 1); // blocks Submit until the durable copy + dispatch below finish
    try {
      const exif = await withLiveGpsFallback(extractExifMetadata(shot.exif));
      // Copy into durable per-draft storage BEFORE dispatching, so the draft (and its autosave) never
      // persists a raw camera uri that would go stale on app-kill. If the copy fails, drop the photo with a
      // notice rather than persisting a stale uri — the user retakes.
      const durableUri = await copyPhotoIntoDraft(ownerKey, draftId, clientUploadId, shot.uri);
      dispatch({
        type: "addPhoto",
        photo: {
          key: clientUploadId, // stable + globally unique → survives resume; removePhoto(by key) can't collide
          uri: durableUri,
          clientUploadId,
          sectionKey,
          deficiencyKey: cameraDeficiency as ScorecardDraftPhoto["deficiencyKey"],
          caption,
          takenAt: exif.takenAt ?? shot.capturedAt,
          latitude: exif.latitude,
          longitude: exif.longitude,
          addressSource: exif.addressSource,
          width: shot.width,
          height: shot.height,
        },
      });
    } catch {
      photoCount.current -= 1; // reservation didn't become a committed photo — release the slot
      setNotice({ tone: "error", text: "Couldn’t save that photo — please retake it." });
    } finally {
      setSavingPhotos((n) => n - 1);
    }
  }

  async function importForSection(sectionIndex: number, deficiencyKey?: string) {
    // Serialize imports: block a second import, or an import fired during a camera save. `savingPhotos` is React
    // state (lags a rapid re-tap), so importInFlight — a synchronous ref flipped BELOW before any await — is what
    // actually bars a double-tap; it's released on every exit. The photo CAP itself is enforced by photoCount
    // (authoritative + synchronous) below, so even a bypass here can't overshoot 100.
    if (importInFlight.current || savingPhotos > 0) {
      setNotice({ tone: "error", text: "Still saving the last photos — try again in a moment." });
      return;
    }
    importInFlight.current = true;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setNotice({ tone: "error", text: "Photo library permission is required to import." });
        return;
      }
      // Cap the pick at the remaining slots under the server's 100-photo limit — otherwise a big multi-select
      // uploads the whole batch and only fails at submit, forcing the user to hunt-and-remove. Measured against
      // the authoritative photoCount (not draft.photos.length), so a camera capture still copying is already
      // counted and the import can't overshoot the cap.
      const remaining = MAX_SCORECARD_PHOTOS - photoCount.current;
      if (remaining <= 0) {
        setNotice({ tone: "error", text: `A scorecard can hold at most ${MAX_SCORECARD_PHOTOS} photos — remove some to import more.` });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 1,
        exif: true,
      });
      if (result.canceled) return;
      const sectionKey = sectionIndex === -1 ? "critical_deficiency" : FIELD_SCORECARD_SECTIONS[sectionIndex].key;
      // Defensive: never exceed the remaining slots even if a platform ignores selectionLimit.
      const assets = result.assets.slice(0, remaining);
      if (assets.length === 0) return;
      // Batch marker so Submit stays blocked (savingPhotos gates it) through the up-to-8s live-GPS lookup below —
      // otherwise the wizard looks idle during it and a submit would ship the old draft, omitting the picked photos.
      setSavingPhotos((n) => n + 1);
      try {
        // Fetch live GPS ONCE for the whole batch and reuse it (mirrors the Capture screen). Doing it per asset
        // would serialize getLiveGps() — up to 8s each — for every coordless photo, freezing a large indoor import.
        const exifs = assets.map((a) => extractExifMetadata(a.exif as Record<string, unknown>));
        const needsLive = exifs.some((e) => e.latitude === undefined || e.longitude === undefined);
        const live = needsLive ? await getLiveGps().catch(() => null) : null;
        for (let i = 0; i < assets.length; i++) {
          const asset = assets[i];
          const clientUploadId = newClientUploadId();
          photoCount.current += 1; // reserve this import slot; released below only if the copy fails
          setSavingPhotos((n) => n + 1);
          try {
            const exif = mergeLiveGps(exifs[i], live);
            // Durable-copy BEFORE dispatch (see onCameraCapture); drop with a notice if the copy fails.
            const durableUri = await copyPhotoIntoDraft(ownerKey, draftId, clientUploadId, asset.uri);
            dispatch({
              type: "addPhoto",
              photo: { key: clientUploadId, uri: durableUri, clientUploadId, sectionKey, deficiencyKey: deficiencyKey as ScorecardDraftPhoto["deficiencyKey"], caption: "", takenAt: exif.takenAt, latitude: exif.latitude, longitude: exif.longitude, addressSource: exif.addressSource, width: asset.width, height: asset.height },
            });
          } catch {
            photoCount.current -= 1; // reservation didn't become a committed photo — release the slot
            setNotice({ tone: "error", text: "Couldn’t import that photo — please try again." });
          } finally {
            setSavingPhotos((n) => n - 1);
          }
        }
      } finally {
        setSavingPhotos((n) => n - 1);
      }
    } finally {
      importInFlight.current = false; // release on every exit: denied, cancel, cap, error, success
    }
  }

  async function onSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setNotice(null);
    // Retry-cancel any still-pending photo removals, so the drain in submitScorecard can't upload a
    // just-removed photo. Only clear on success — a failure keeps the ids pending AND blocks submit
    // (rather than silently shipping stale evidence).
    if (pendingRemovalIds.current.size > 0) {
      try {
        await removeQueuedUploads(ownerKey, [...pendingRemovalIds.current]);
        pendingRemovalIds.current.clear();
      } catch {
        setNotice({ tone: "error", text: "Couldn’t finish removing a photo — please try again." });
        setSubmitting(false);
        return;
      }
    }
    try {
      const result = await submitScorecard(fetcher, ownerKey, draft);
      if (result.status === "photos_failed") {
        setNotice({ tone: "error", text: `${result.failed} photo${result.failed === 1 ? "" : "s"} couldn’t upload after several tries. Remove and re-add ${result.failed === 1 ? "it" : "them"}, then submit.` });
        setSubmitting(false);
        return;
      }
      if (result.status === "photos_pending") {
        setNotice({ tone: "error", text: `${result.remaining} photo${result.remaining === 1 ? "" : "s"} still uploading — they’ll keep retrying. Try Submit again shortly.` });
        setSubmitting(false);
        return;
      }
      // Server accepted the card — the submission is COMPLETE. Everything below is best-effort local
      // cleanup: it must never block navigation or the recent-list refresh. finalized stays true so autosave
      // can't resurrect a submitted draft; a failed local delete just leaves a harmless orphan draft (re-
      // submitting it is idempotent on clientSubmissionId — the server returns the existing card).
      finalized.current = true;
      await saveChain.current.catch(() => undefined); // let any in-flight autosave settle (it will skip)
      await deleteScorecardDraft(ownerKey, draftId).catch(() => undefined);
      onSubmitted(draft.dealId);
    } catch {
      setNotice({ tone: "error", text: "Couldn’t submit the scorecard. Your work is saved — try again." });
      setSubmitting(false);
    }
  }

  const title = step === 0 ? "Project Scorecard" : FIELD_SCORECARD_SECTIONS[step - 1].title;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader onBack={goBack} title={draft.dealName} />
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${(step / LAST_STEP) * 100}%` }]} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.stepTitle}>{title}</Text>
        {notice ? <Banner message={notice.text} tone={notice.tone} /> : null}

        {step === 0 ? (
          <OverviewStep
            draft={draft}
            dispatch={dispatch}
            onOpenSection={(index) => setStep(index + 1)}
            onAddDeficiencyPhoto={(key) => { setCameraDeficiency(key); setCameraSection(-1); }}
            onImportDeficiencyPhoto={(key) => void importForSection(-1, key)}
            onEditPhoto={(photo) => setCaptionPhotoKey(photo.key)}
            onSign={(field) => setSigningField(field)}
            voiceEnabled={voiceEnabled}
            photosBusy={savingPhotos > 0}
          />
        ) : (
          <SectionStep
            sectionIndex={step - 1}
            draft={draft}
            dispatch={dispatch}
            voiceEnabled={voiceEnabled}
            onAddPhoto={() => setCameraSection(step - 1)}
            onImport={() => void importForSection(step - 1)}
            photosBusy={savingPhotos > 0}
            onRemovePhoto={removePhotoAndCancelUpload}
            onEditPhoto={(photo) => setCaptionPhotoKey(photo.key)}
          />
        )}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.totalPill}>
          <Text style={styles.totalText}>{total}/100</Text>
        </View>
        {step > 0 ? (
          <Button title="Done" onPress={() => setStep(0)} style={{ flex: 1 }} />
        ) : (
          <Button title={savingPhotos > 0 ? "Saving photo…" : "Submit ✓"} onPress={onSubmit} loading={submitting} disabled={!validation.canSubmit || submitting || savingPhotos > 0} style={{ flex: 1 }} />
        )}
      </View>

      {cameraSection !== null ? (
        <Suspense fallback={null}>
          <CameraCapture
            onCapture={(shot, caption) => void onCameraCapture(shot, caption)}
            onClose={() => setCameraSection(null)}
            count={draft.photos.filter((photo) => cameraSection === -1 ? photo.sectionKey === "critical_deficiency" && photo.deficiencyKey === cameraDeficiency : photo.sectionKey === FIELD_SCORECARD_SECTIONS[cameraSection].key).length}
            recent={draft.photos.filter((photo) => cameraSection === -1 ? photo.sectionKey === "critical_deficiency" && photo.deficiencyKey === cameraDeficiency : photo.sectionKey === FIELD_SCORECARD_SECTIONS[cameraSection].key).slice(-5).map((p) => p.uri)}
            annotatePerShot
            voiceEnabled={voiceEnabled}
          />
        </Suspense>
      ) : null}

      <Modal visible={captionPhoto !== null} transparent animationType="slide" onRequestClose={() => !captionVoiceBusy && setCaptionPhotoKey(null)}>
        <KeyboardAvoidingView style={styles.captionModalRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.captionBackdrop} onPress={() => !captionVoiceBusy && setCaptionPhotoKey(null)} accessibilityLabel="Close photo description" />
          {captionPhoto ? (
            <SafeAreaView edges={["bottom"]} style={styles.captionSheet}>
              <PhotoCaptionEditor
                uri={captionPhoto.uri}
                caption={captionPhoto.caption}
                onChangeCaption={(caption) => dispatch({ type: "setPhotoCaption", key: captionPhoto.key, caption })}
                onAppendCaption={(text) => dispatch({ type: "appendPhotoCaption", key: captionPhoto.key, text })}
                voiceEnabled={voiceEnabled}
                onBusyChange={setCaptionVoiceBusy}
                autoFocus
                label="Description"
                hint="Optional. This description stays with this photo."
                footer={<Button title="Done" onPress={() => setCaptionPhotoKey(null)} disabled={captionVoiceBusy} />}
              />
            </SafeAreaView>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={signingField !== null} animationType="slide" onRequestClose={() => setSigningField(null)}>
        <SafeAreaView style={styles.signatureModal}>
          <View style={styles.signatureHeader}>
            <Text style={styles.stepTitle}>{signingField === "superintendentSignature" ? "Superintendent signature" : "Project manager signature"}</Text>
            <Pressable onPress={() => setSigningField(null)} accessibilityRole="button" accessibilityLabel="Close signature pad">
              <Text style={styles.signatureClose}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>Sign in the box below, then tap Save.</Text>
          {signingField ? (
            <View style={styles.signatureCanvas}>
              <SignatureScreen
                onOK={(signature) => {
                  dispatch({ type: "setSignature", field: signingField, value: signature });
                  setSigningField(null);
                }}
                onEmpty={() => setNotice({ tone: "error", text: "Please add a signature before saving." })}
                descriptionText=""
                clearText="Clear"
                confirmText="Save"
                webStyle={signatureWebStyle}
              />
            </View>
          ) : null}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function OverviewStep({
  draft,
  dispatch,
  onOpenSection,
  onAddDeficiencyPhoto,
  onImportDeficiencyPhoto,
  onEditPhoto,
  onSign,
  voiceEnabled,
  photosBusy,
}: {
  draft: ScorecardDraft;
  dispatch: React.Dispatch<DraftAction>;
  onOpenSection: (index: number) => void;
  onAddDeficiencyPhoto: (key: string) => void;
  onImportDeficiencyPhoto: (key: string) => void;
  onEditPhoto: (photo: ScorecardDraftPhoto) => void;
  onSign: (field: "superintendentSignature" | "pmSignature") => void;
  voiceEnabled: boolean;
  photosBusy: boolean;
}) {
  const average = scorecardDraftTotal(draft);
  const answered = Object.keys(draft.scores).length;
  return (
    <View style={{ gap: theme.space.lg }}>
      <View style={styles.scoreWrap}>
        <Text style={styles.bigScore}>{average.toFixed(1)}<Text style={styles.bigScoreMax}> /10</Text></Text>
        <RatingBadge rating={scorecardDraftRating(draft)} label={scorecardRatingLabel(scorecardDraftRating(draft))} />
        <Text style={styles.hint}>{String(answered) + "/" + String(SECTION_COUNT) + " categories rated"}</Text>
      </View>

      <View style={{ gap: theme.space.md }}>
        <Field label="Project"><Text style={styles.readonly}>{draft.dealName}</Text></Field>
        {draft.projectNumber ? <Field label="Project number"><Text style={styles.readonly}>{draft.projectNumber}</Text></Field> : null}
        <Field label="Superintendent">
          <TextInput value={draft.superintendentName} onChangeText={(value) => dispatch({ type: "setHeader", field: "superintendentName", value })} placeholder="Name" />
        </Field>
        <Field label="Project manager">
          <TextInput value={draft.pmName} onChangeText={(value) => dispatch({ type: "setHeader", field: "pmName", value })} placeholder="Name" />
        </Field>
        <Field label="Week of"><Text style={styles.readonly}>Set automatically when completed</Text></Field>
      </View>

      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Category ratings</SectionLabel>
        {FIELD_SCORECARD_SECTIONS.map((section, index) => {
          const score = draft.scores[section.key] ?? 5;
          const photoCount = scorecardDraftPhotosForSection(draft, section.key).length;
          return (
            <View key={section.key} style={styles.categoryCard}>
              <View style={styles.categoryHeading}>
                <Text style={styles.categoryTitle}>{section.title}</Text>
                <Text style={styles.categoryScore}>{String(score) + "/10"}</Text>
              </View>
              <ScoreSlider value={score} onChange={(points) => dispatch({ type: "setScore", sectionKey: section.key, points })} />
              <Pressable onPress={() => onOpenSection(index)} style={styles.categoryAction} accessibilityRole="button">
                <Text style={styles.categoryActionText}>{photoCount > 0 ? String(photoCount) + (photoCount === 1 ? " photo · Edit action items" : " photos · Edit action items") : "Add action items or photos"}</Text>
                <Text style={styles.summaryChevron}>›</Text>
              </Pressable>
            </View>
          );
        })}
      </View>

      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Critical deficiencies</SectionLabel>
        <Text style={styles.hint}>Select each issue that applies. Attach evidence directly to the selected issue.</Text>
        {FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((deficiency) => {
          const selected = draft.criticalDeficiencies.includes(deficiency.key);
          const count = draft.photos.filter((photo) => photo.sectionKey === "critical_deficiency" && photo.deficiencyKey === deficiency.key).length;
          const photos = draft.photos.filter((photo) => photo.sectionKey === "critical_deficiency" && photo.deficiencyKey === deficiency.key);
          const note = draft.deficiencyNotes?.[deficiency.key] ?? "";
          return (
            <View key={deficiency.key} style={[styles.deficiencyCard, selected && styles.deficiencyCardSelected]}>
              <Pressable
                onPress={() => dispatch({ type: "toggleDeficiency", key: deficiency.key })}
                style={styles.deficiencyToggle}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
              >
                <View style={[styles.box, selected && styles.boxOn]}>{selected ? <Text style={styles.boxCheck}>✓</Text> : null}</View>
                <Text style={styles.checkLabel}>{deficiency.label}</Text>
              </Pressable>
              {selected ? (
                <>
                  <Field label="Description">
                    <TextInput
                      value={note}
                      onChangeText={(text) => dispatch({ type: "setDeficiencyNote", key: deficiency.key, note: text })}
                      placeholder="Describe the issue, impact, and correction needed"
                      multiline
                      style={{ minHeight: 84, textAlignVertical: "top", paddingTop: 10 }}
                    />
                    {voiceEnabled ? <VoiceRecorder onTranscript={(text) => dispatch({ type: "appendDeficiencyNote", key: deficiency.key, text })} /> : null}
                  </Field>
                  <View style={styles.deficiencyActions}>
                    <Button title={count ? String(count) + (count === 1 ? " photo" : " photos") : "Camera"} variant="ghost" onPress={() => onAddDeficiencyPhoto(deficiency.key)} disabled={photosBusy} style={{ flex: 1 }} />
                    <Button title="Library" variant="ghost" onPress={() => onImportDeficiencyPhoto(deficiency.key)} disabled={photosBusy} style={{ flex: 1 }} />
                  </View>
                  {photos.length > 0 ? (
                    <View style={styles.photoRow}>
                      {photos.map((photo) => (
                        <Pressable key={photo.key} onPress={() => onEditPhoto(photo)} accessibilityRole="button" accessibilityLabel="Edit photo description">
                          <Image source={{ uri: photo.uri }} style={styles.thumb} />
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </>
              ) : null}
            </View>
          );
        })}
      </View>

      <View style={{ gap: theme.space.md }}>
        <SectionLabel>Signatures</SectionLabel>
        <Pressable onPress={() => onSign("superintendentSignature")} style={styles.signatureTrigger} accessibilityRole="button">
          <Text style={styles.signatureTriggerLabel}>Superintendent</Text>
          <Text style={styles.signatureTriggerValue}>{draft.superintendentSignature ? "Signed · tap to replace" : "Tap to sign"}</Text>
        </Pressable>
        <Pressable onPress={() => onSign("pmSignature")} style={styles.signatureTrigger} accessibilityRole="button">
          <Text style={styles.signatureTriggerLabel}>Project manager</Text>
          <Text style={styles.signatureTriggerValue}>{draft.pmSignature ? "Signed · tap to replace" : "Tap to sign"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ScoreSlider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <View style={styles.sliderTicks}>
      {Array.from({ length: 10 }, (_, index) => (
        <Pressable key={index} onPress={() => onChange(index + 1)} style={[styles.sliderTick, index + 1 <= value && styles.sliderTickActive]}>
          <Text style={[styles.sliderTickText, index + 1 === value && styles.sliderTickTextSelected]}>{index + 1}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function SetupStep({ draft, dispatch }: { draft: ScorecardDraft; dispatch: React.Dispatch<DraftAction> }) {
  return (
    <View style={{ gap: theme.space.md }}>
      <Field label="Project"><Text style={styles.readonly}>{draft.dealName}</Text></Field>
      {draft.projectNumber ? <Field label="Project number"><Text style={styles.readonly}>{draft.projectNumber}</Text></Field> : null}
      <Field label="Superintendent">
        <TextInput value={draft.superintendentName} onChangeText={(v) => dispatch({ type: "setHeader", field: "superintendentName", value: v })} placeholder="Name" />
      </Field>
      <Field label="Project manager">
        <TextInput value={draft.pmName} onChangeText={(v) => dispatch({ type: "setHeader", field: "pmName", value: v })} placeholder="Name" />
      </Field>
      <Field label="Week of (YYYY-MM-DD)">
        <TextInput value={draft.weekOf} onChangeText={(v) => dispatch({ type: "setHeader", field: "weekOf", value: v })} placeholder="2026-06-30" autoCapitalize="none" />
      </Field>
    </View>
  );
}

function SectionStep({
  sectionIndex, draft, dispatch, voiceEnabled, onAddPhoto, onImport, photosBusy, onRemovePhoto, onEditPhoto,
}: {
  sectionIndex: number; draft: ScorecardDraft; dispatch: React.Dispatch<DraftAction>;
  voiceEnabled: boolean; onAddPhoto: () => void; onImport: () => void; photosBusy: boolean;
  onRemovePhoto: (photo: ScorecardDraftPhoto) => void;
  onEditPhoto: (photo: ScorecardDraftPhoto) => void;
}) {
  const section = FIELD_SCORECARD_SECTIONS[sectionIndex];
  const selected = draft.scores[section.key];
  const note = draft.notes[section.key] ?? "";
  const photos = scorecardDraftPhotosForSection(draft, section.key);
  // Disable both photo actions while a batch is in flight or the draft is at the cap — the handlers also guard
  // this, but disabling avoids the user firing a capture/import that just bounces with a notice.
  const photosDisabled = photosBusy || draft.photos.length >= MAX_SCORECARD_PHOTOS;
  return (
    <View style={{ gap: theme.space.md }}>
      <Text style={styles.hint}>Rate this category, then document any action items or evidence.</Text>
      <View style={styles.detailScoreBlock}>
        <Text style={styles.detailScore}>{selected ?? "—"}<Text style={styles.bigScoreMax}> /10</Text></Text>
        <ScoreSlider value={selected ?? 5} onChange={(points) => dispatch({ type: "setScore", sectionKey: section.key, points })} />
      </View>
      <Field label="Action items">
        <TextInput value={note} onChangeText={(v) => dispatch({ type: "setNote", sectionKey: section.key, note: v })} placeholder="Describe the action needed" multiline style={{ minHeight: 96, textAlignVertical: "top", paddingTop: 10 }} />
        {voiceEnabled ? (
          <VoiceRecorder onTranscript={(t) => dispatch({ type: "appendNote", sectionKey: section.key, text: t })} />
        ) : null}
      </Field>
      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Evidence photos ({photos.length})</SectionLabel>
        <View style={styles.photoRow}>
          {photos.map((p) => (
            <View key={p.key} style={styles.thumbWrap}>
              <Pressable
                onPress={() => onEditPhoto(p)}
                accessibilityRole="button"
                accessibilityLabel={p.caption.trim() ? "Photo with description. Edit description." : "Photo. Add description."}
              >
                <Image source={{ uri: p.uri }} style={styles.thumb} />
                <View style={styles.thumbCaption}>
                  <Text style={styles.thumbCaptionText}>{p.caption.trim() ? "Edit" : "Describe"}</Text>
                </View>
              </Pressable>
              <Pressable onPress={() => onRemovePhoto(p)} hitSlop={8} style={styles.thumbX}>
                <Text style={styles.thumbXText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
        {photos.length > 0 ? <Text style={styles.photoHint}>Tap a photo to add a description or dictate it.</Text> : null}
        <View style={styles.actions}>
          <Button title="Add photo" variant="ghost" onPress={onAddPhoto} disabled={photosDisabled} style={{ flex: 1 }} />
          <Button title="Import" variant="ghost" onPress={onImport} disabled={photosDisabled} style={{ flex: 1 }} />
        </View>
      </View>
    </View>
  );
}

function DeficienciesStep({ draft, dispatch }: { draft: ScorecardDraft; dispatch: React.Dispatch<DraftAction> }) {
  return (
    <View style={{ gap: theme.space.xs }}>
      <Text style={styles.hint}>Check all that apply.</Text>
      {FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => {
        const on = draft.criticalDeficiencies.includes(d.key);
        return (
          <Pressable
            key={d.key}
            onPress={() => dispatch({ type: "toggleDeficiency", key: d.key })}
            style={styles.check}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={d.label}
          >
            <View style={[styles.box, on && styles.boxOn]}>{on ? <Text style={styles.boxCheck}>✓</Text> : null}</View>
            <Text style={styles.checkLabel}>{d.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ActionsStep({ draft, dispatch, voiceEnabled, required }: { draft: ScorecardDraft; dispatch: React.Dispatch<DraftAction>; voiceEnabled: boolean; required: boolean }) {
  const text = draft.actionItems.join("\n");
  return (
    <View style={{ gap: theme.space.sm }}>
      <Text style={[styles.hint, required && { color: theme.color.warning }]}>
        {required ? "Required — score below 85 or a deficiency was flagged. Add at least one." : "Optional. One per line."}
      </Text>
      <TextInput
        value={text}
        onChangeText={(v) => dispatch({ type: "setActionItems", items: v.split("\n") })}
        placeholder={"Re-inspect failed slab\nSchedule recovery meeting"}
        multiline
        style={{ minHeight: 120, textAlignVertical: "top", paddingTop: 10 }}
      />
      {voiceEnabled ? (
        <VoiceRecorder onTranscript={(t) => dispatch({ type: "appendActionItem", text: t })} />
      ) : null}
    </View>
  );
}

function ReviewStep({ draft, onEditStep }: { draft: ScorecardDraft; onEditStep: (step: number) => void }) {
  // Step indices for the non-section blockers so the review page can send the user straight to them.
  const ACTION_ITEMS_STEP = SECTION_COUNT + 2;
  const SETUP_STEP = 0;
  const total = scorecardDraftTotal(draft);
  const rating = scorecardDraftRating(draft);
  const validation = validateScorecardDraft(draft);
  return (
    <View style={{ gap: theme.space.md }}>
      <View style={styles.scoreWrap}>
        <Text style={styles.bigScore}>{total}<Text style={styles.bigScoreMax}> /100</Text></Text>
        <RatingBadge rating={rating} label={scorecardRatingLabel(rating)} />
      </View>
      <View style={{ gap: 2 }}>
        {FIELD_SCORECARD_SECTIONS.map((s, i) => {
          const pts = draft.scores[s.key];
          const scored = typeof pts === "number";
          // Every row jumps back to its section; unscored ("needs review") rows get a red accent + a
          // "Score" call-to-action so it's obvious they're both tappable and still required.
          return (
            <Pressable
              key={s.key}
              onPress={() => onEditStep(1 + i)}
              accessibilityRole="button"
              accessibilityLabel={scored ? `${s.title}: ${pts} points. Tap to edit.` : `${s.title} still needs a score. Tap to fill it in.`}
              style={({ pressed }) => [styles.summaryRow, !scored && styles.summaryRowMissing, pressed && styles.summaryRowPressed]}
            >
              <Text style={[styles.summaryName, !scored && styles.summaryNameMissing]} numberOfLines={1}>{s.title}</Text>
              {scored ? (
                <View style={styles.summaryRight}>
                  <Text style={styles.summaryPts}>{pts}</Text>
                  <Text style={styles.summaryChevron}>›</Text>
                </View>
              ) : (
                <View style={styles.summaryRight}>
                  <Text style={styles.summaryCta}>Score</Text>
                  <Text style={styles.summaryChevronRed}>›</Text>
                </View>
              )}
            </Pressable>
          );
        })}
        {/* Non-section requirements that also block submit — surfaced as tappable rows so the user isn't
            told "action items required" with no way to get there from the review screen. Only shown once
            every section is scored: the total (and thus the action-items requirement) is meaningless while
            scores are missing — the red section rows above are the guidance until then. Mirrors the submit
            Banner's stage priority. */}
        {validation.missingSections.length === 0 && validation.needsActionItems ? (
          <Pressable
            onPress={() => onEditStep(ACTION_ITEMS_STEP)}
            accessibilityRole="button"
            accessibilityLabel="Action items are required. Tap to add one."
            style={({ pressed }) => [styles.summaryRow, styles.summaryRowMissing, pressed && styles.summaryRowPressed]}
          >
            <Text style={[styles.summaryName, styles.summaryNameMissing]} numberOfLines={1}>Action items</Text>
            <View style={styles.summaryRight}>
              <Text style={styles.summaryCta}>Add</Text>
              <Text style={styles.summaryChevronRed}>›</Text>
            </View>
          </Pressable>
        ) : null}
        {validation.missingSections.length === 0 && validation.missingWeekOf ? (
          <Pressable
            onPress={() => onEditStep(SETUP_STEP)}
            accessibilityRole="button"
            accessibilityLabel="The Week Of date is required. Tap to set it."
            style={({ pressed }) => [styles.summaryRow, styles.summaryRowMissing, pressed && styles.summaryRowPressed]}
          >
            <Text style={[styles.summaryName, styles.summaryNameMissing]} numberOfLines={1}>Week of date</Text>
            <View style={styles.summaryRight}>
              <Text style={styles.summaryCta}>Set</Text>
              <Text style={styles.summaryChevronRed}>›</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
      {draft.criticalDeficiencies.length > 0 ? <Badge label={`${draft.criticalDeficiencies.length} deficiency flag${draft.criticalDeficiencies.length === 1 ? "" : "s"}`} /> : null}
      {!validation.canSubmit ? (
        <Banner
          tone="error"
          message={
            validation.missingSections.length > 0
              ? `Score all ${SECTION_COUNT} sections to submit (${validation.missingSections.length} left).`
              : validation.needsActionItems
                ? "Add at least one action item to submit."
                : validation.missingWeekOf
                  ? "Set the Week Of date to submit."
                  : "Complete the required fields to submit."
          }
        />
      ) : null}
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: theme.space.xs }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const signatureWebStyle = `
  .m-signature-pad { box-shadow: none; border: 0; height: 100%; }
  .m-signature-pad--body { border: 0; }
  .m-signature-pad--footer { background: #fff; border-top: 1px solid #e2e8f0; }
  .button { background: #dc2626; color: #fff; border-radius: 6px; }
  .button.clear { background: #fff; color: #dc2626; border: 1px solid #dc2626; }
`;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  progressTrack: { height: 4, backgroundColor: theme.color.surfaceMuted },
  progressFill: { height: 4, backgroundColor: theme.color.brandRed },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  stepTitle: { fontFamily: theme.font.bold, fontSize: 20, color: theme.color.textPrimary },
  hint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  fieldLabel: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textPrimary },
  readonly: { fontFamily: theme.font.medium, fontSize: 15, color: theme.color.textPrimary, paddingVertical: 6 },
  opt: {
    flexDirection: "row", alignItems: "center", gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard, borderWidth: 1, borderColor: theme.color.border,
    borderRadius: theme.radius.md, padding: theme.space.md,
  },
  optActive: { borderColor: theme.color.brandRed, borderWidth: 2, backgroundColor: "#FEF2F2" },
  optPts: { fontFamily: theme.font.bold, fontSize: 16, color: theme.color.textPrimary, minWidth: 26 },
  optPtsActive: { color: theme.color.brandRed },
  optLabel: { flex: 1, fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  radio: { width: 18, height: 18, borderRadius: 999, borderWidth: 2, borderColor: theme.color.border },
  radioActive: { borderColor: theme.color.brandRed, backgroundColor: theme.color.brandRed },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  thumbWrap: { position: "relative" },
  thumb: { width: 64, height: 64, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  thumbX: { position: "absolute", top: -6, right: -6, backgroundColor: theme.color.brandBlack, borderRadius: 999, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  thumbXText: { color: "#fff", fontSize: 11, fontFamily: theme.font.bold },
  thumbCaption: { position: "absolute", left: 0, right: 0, bottom: 0, paddingVertical: 2, backgroundColor: "rgba(17,17,17,0.72)", alignItems: "center" },
  thumbCaptionText: { color: "#fff", fontFamily: theme.font.semibold, fontSize: 9 },
  photoHint: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  actions: { flexDirection: "row", gap: theme.space.md },
  check: { flexDirection: "row", alignItems: "center", gap: theme.space.md, paddingVertical: theme.space.sm, borderBottomWidth: 1, borderBottomColor: theme.color.surfaceMuted },
  box: { width: 22, height: 22, borderRadius: theme.radius.sm, borderWidth: 2, borderColor: theme.color.border, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: theme.color.brandRed, borderColor: theme.color.brandRed },
  boxCheck: { color: "#fff", fontFamily: theme.font.bold, fontSize: 13 },
  checkLabel: { flex: 1, fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary },
  scoreWrap: { alignItems: "center", gap: theme.space.sm, paddingVertical: theme.space.md },
  bigScore: { fontFamily: theme.font.bold, fontSize: 44, color: theme.color.textPrimary },
  bigScoreMax: { fontSize: 18, color: theme.color.textMuted },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: theme.space.sm, paddingHorizontal: theme.space.sm, borderBottomWidth: 1, borderBottomColor: theme.color.surfaceMuted, borderLeftWidth: 3, borderLeftColor: "transparent" },
  summaryRowMissing: { backgroundColor: "rgba(220,40,40,0.06)", borderLeftColor: theme.color.brandRed, borderBottomColor: "transparent" },
  summaryRowPressed: { opacity: 0.55 },
  summaryName: { flex: 1, fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary },
  summaryNameMissing: { fontFamily: theme.font.bold, color: theme.color.danger },
  summaryRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  summaryPts: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textPrimary },
  summaryCta: { fontFamily: theme.font.bold, fontSize: 13, color: theme.color.brandRed },
  summaryChevron: { fontFamily: theme.font.body, fontSize: 20, lineHeight: 20, color: theme.color.textMuted },
  summaryChevronRed: { fontFamily: theme.font.body, fontSize: 20, lineHeight: 20, color: theme.color.brandRed },
  categoryCard: { backgroundColor: theme.color.surfaceCard, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.space.md, gap: theme.space.sm },
  categoryHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.md },
  categoryTitle: { flex: 1, fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  categoryScore: { fontFamily: theme.font.bold, fontSize: 16, color: theme.color.brandRed },
  categoryAction: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: theme.space.xs },
  categoryActionText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.brandRed },
  sliderTicks: { flexDirection: "row", justifyContent: "space-between", gap: 3 },
  sliderTick: { flex: 1, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted, borderWidth: 1, borderColor: theme.color.border },
  sliderTickActive: { backgroundColor: "#FEE2E2", borderColor: "#FCA5A5" },
  sliderTickText: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textMuted },
  sliderTickTextSelected: { color: theme.color.brandRed, fontFamily: theme.font.bold },
  detailScoreBlock: { gap: theme.space.md, alignItems: "center", paddingVertical: theme.space.sm },
  detailScore: { fontFamily: theme.font.bold, fontSize: 36, color: theme.color.textPrimary },
  deficiencyCard: { borderBottomWidth: 1, borderBottomColor: theme.color.surfaceMuted, paddingVertical: theme.space.sm, gap: theme.space.sm },
  deficiencyCardSelected: { backgroundColor: "rgba(220,40,40,0.05)", paddingHorizontal: theme.space.sm, borderRadius: theme.radius.sm, borderBottomColor: "transparent" },
  deficiencyToggle: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  deficiencyActions: { flexDirection: "row", gap: theme.space.sm, paddingLeft: 34 },
  captionModalRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.35)" },
  captionBackdrop: { ...StyleSheet.absoluteFillObject },
  captionSheet: { gap: theme.space.md, backgroundColor: theme.color.surfaceCard, borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg, padding: theme.space.lg },
  signatureModal: { flex: 1, gap: theme.space.md, backgroundColor: theme.color.surfaceApp, padding: theme.space.lg },
  signatureHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.md },
  signatureClose: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  signatureCanvas: { flex: 1, minHeight: 340, overflow: "hidden", borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceCard },
  signatureTrigger: { gap: 3, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceCard, padding: theme.space.md },
  signatureTriggerLabel: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  signatureTriggerValue: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.brandRed },
  footer: {
    flexDirection: "row", alignItems: "center", gap: theme.space.md,
    padding: theme.space.md, borderTopWidth: 1, borderTopColor: theme.color.border, backgroundColor: theme.color.surfaceCard,
  },
  totalPill: { backgroundColor: theme.color.surfaceMuted, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: 8 },
  totalText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.textPrimary },
});
