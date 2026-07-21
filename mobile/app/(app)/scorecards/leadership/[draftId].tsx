// Leadership Scorecard form. A focused screen (not the project wizard) that REUSES the shared scorecard
// machinery — the same draft model, draft-store persistence, ScoreSlider/VoiceRecorder components, the
// durable photo capture/import queue, and submitScorecard — but renders the leadership shape: an Evaluator
// (auto-filled, editable) + editable PM/Super header, the 4 categories (1-10 + dictatable comment + evidence
// photos), and a Project Summary block (the 4-category average + a dictatable summary + optional photos).
// No signatures, no deficiencies. The project wizard at ../[draftId].tsx is untouched.

import React, { Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePreventRemove } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { theme } from "../../../../src/theme/theme";
import { useAuth } from "../../../../src/auth/AuthContext";
import { getScorecard, getTranscriptionConfig, type Fetcher } from "../../../../src/api/endpoints";
import { apiFetch } from "../../../../src/api/client";
import { uploadOwnerKey, newClientUploadId, removeQueuedUploads } from "../../../../src/capture/upload-queue";
import { qk } from "../../../../src/query/keys";
import { extractExifMetadata, getLiveGps, type PhotoMetadata } from "../../../../src/capture/metadata";
import type { CapturedShot } from "../../../../src/capture/CameraCapture";
import {
  FIELD_SCORECARD_LEADERSHIP_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  scorecardRatingLabel,
  type ScorecardLeadershipSectionKey,
} from "../../../../src/scorecards/scoring";
import {
  scorecardDraftReducer,
  scorecardDraftAverage,
  scorecardDraftRating,
  scorecardDraftSectionsAnswered,
  scorecardDraftPhotosForSection,
  scorecardDraftNewPhotos,
  markScorecardEvidenceUploadAttempted,
  isEditingScorecardDraft,
  isExistingScorecardDraftPhoto,
  isScorecardDraftPhotoCaptionEditable,
  validateScorecardDraft,
  MAX_SCORECARD_PHOTOS,
  type ScorecardDraft,
  type ScorecardDraftPhoto,
  type DraftAction,
} from "../../../../src/scorecards/draft";
import { rebaseScorecardEditDraft, scorecardEditRebaseMessage } from "../../../../src/scorecards/edit";
import { scorecardEditorBusyMessage, scorecardEditorSubmitError, scorecardPhotoOverflowMessage, scorecardPhotosMissingMessage } from "../../../../src/scorecards/editor-state";
import { loadScorecardDraft, saveScorecardDraft, deleteScorecardDraft, copyPhotoIntoDraft } from "../../../../src/scorecards/draft-store";
import { submitScorecard } from "../../../../src/scorecards/submit";
import { Button, EmptyState, LoadingState, SectionLabel, TextInput } from "../../../../src/components/ui";
import { Banner } from "../../../../src/components/Banner";
import { ScreenHeader } from "../../../../src/components/ScreenHeader";
import { RatingBadge } from "../../../../src/components/RatingBadge";
import { VoiceRecorder } from "../../../../src/components/VoiceRecorder";
import { PhotoCaptionEditor } from "../../../../src/components/PhotoCaptionEditor";

const CameraCapture = React.lazy(() => import("../../../../src/capture/CameraCapture"));

const SUMMARY_KEY = FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY;
type LeadershipPhotoSectionKey = ScorecardLeadershipSectionKey | typeof SUMMARY_KEY;
const CATEGORY_COUNT = FIELD_SCORECARD_LEADERSHIP_SECTIONS.length;

function toStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

// Merge an already-resolved live GPS fix into a shot's EXIF only when the shot itself has no location. Pure so a
// BATCH import can fetch live GPS ONCE and reuse it across every coordless asset (mirrors the project wizard).
function mergeLiveGps(exif: ReturnType<typeof extractExifMetadata>, live: PhotoMetadata | null) {
  if (exif.latitude !== undefined && exif.longitude !== undefined) return exif;
  if (live && live.latitude !== undefined && live.longitude !== undefined) {
    return { ...exif, latitude: live.latitude, longitude: live.longitude, addressSource: live.addressSource ?? exif.addressSource };
  }
  return exif;
}

async function withLiveGpsFallback(exif: ReturnType<typeof extractExifMetadata>) {
  if (exif.latitude !== undefined && exif.longitude !== undefined) return exif;
  return mergeLiveGps(exif, await getLiveGps().catch(() => null));
}

export default function LeadershipScorecardScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ draftId: string; officeId?: string }>();
  const draftId = toStr(params.draftId);
  const routeOfficeId = toStr(params.officeId);
  const { fetcher, user, activeOfficeId, token, signOut } = useAuth();
  const qc = useQueryClient();
  const resolvedOfficeId = routeOfficeId || activeOfficeId || user?.tenantId || null;
  const ownerKey = uploadOwnerKey(user?.id, resolvedOfficeId ?? undefined);
  // Scope the default durable evidence drain and NEW scorecard POST to the draft's office. Scorecard-id edit
  // GET/PUT calls use the headerless fetcher below so a stale office cannot block the owning-office resolver.
  const queueFetcher = useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, { ...opts, token: token ?? undefined, officeId: resolvedOfficeId, onUnauthorized: () => void signOut() }),
    [token, resolvedOfficeId, signOut],
  );
  // Scorecard-id GET/PUT and marked edit evidence are target-resolved server-side. Never send the persisted
  // owning-office header here: it can become unauthorized if the original submitter is later re-homed.
  const scorecardFetcher = useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, { ...opts, token: token ?? undefined, officeId: null, onUnauthorized: () => void signOut() }),
    [token, signOut],
  );

  const [loaded, setLoaded] = useState<ScorecardDraft | null | "missing">(null);
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
    setLoaded(null);
    setSubmitting(false);
    setNotice(null);
    let cancelled = false;
    // Render the persisted edit first. Retained-photo URLs refresh from inside the mounted reducer, so an
    // offline request cannot make local scores, notes, summary, or evidence wait behind the API timeout.
    void loadScorecardDraft(ownerKey, draftId)
      .then((d) => {
        if (!cancelled) setLoaded(d ?? "missing");
      })
      .catch(() => {
        if (!cancelled) setLoaded("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [ownerKey, draftId]);

  // A project draft belongs to the project wizard (its own steps + signatures). If one is reached here via a
  // deep link / stale route, hand it off rather than rendering it as a leadership card. `replace` so Back
  // doesn't bounce between the two screens. Mirrors the project screen's leadership → leadership guard.
  useEffect(() => {
    if (loaded && loaded !== "missing" && loaded.kind !== "leadership") {
      router.replace({
        pathname: "/(app)/scorecards/[draftId]",
        params: { draftId, ...(routeOfficeId ? { officeId: routeOfficeId } : {}) },
      });
    }
  }, [loaded, draftId, routeOfficeId, router]);

  if (loaded === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Leadership Scorecard" />
        <LoadingState label="Loading…" />
      </SafeAreaView>
    );
  }
  if (loaded === "missing") {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Leadership Scorecard" />
        <EmptyState title="Draft not found" subtitle="It may have been submitted or deleted." />
      </SafeAreaView>
    );
  }
  // Project draft opened via the leadership route → handed off by the effect above; show a spinner instead of
  // briefly mounting the leadership form for it.
  if (loaded.kind !== "leadership") {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Leadership Scorecard" />
        <LoadingState label="Loading…" />
      </SafeAreaView>
    );
  }

  return (
    <LeadershipForm
      key={draftId}
      initial={loaded}
      ownerKey={ownerKey!}
      draftId={draftId}
      submitting={submitting}
      setSubmitting={setSubmitting}
      notice={notice}
      setNotice={setNotice}
      voiceEnabled={voiceEnabled}
      onSubmitted={(dealId, scorecardId) => {
        if (user) {
          void qc.invalidateQueries({ queryKey: ["scorecards-recent", user.id] });
          void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, dealId) });
          void qc.invalidateQueries({ queryKey: qk.projectScorecards(user.id, dealId) });
          if (scorecardId) void qc.invalidateQueries({ queryKey: qk.scorecard(user.id, scorecardId) });
        }
        router.back();
      }}
      fetcher={scorecardFetcher}
      draftOfficeFetcher={queueFetcher}
    />
  );
}

function LeadershipForm(props: {
  initial: ScorecardDraft;
  ownerKey: string;
  draftId: string;
  submitting: boolean;
  setSubmitting: (b: boolean) => void;
  notice: { tone: "success" | "error"; text: string } | null;
  setNotice: (n: { tone: "success" | "error"; text: string } | null) => void;
  voiceEnabled: boolean;
  onSubmitted: (dealId: string, scorecardId?: string) => void;
  fetcher: ReturnType<typeof useAuth>["fetcher"];
  draftOfficeFetcher: Fetcher;
}) {
  const { ownerKey, draftId, submitting, setSubmitting, notice, setNotice, voiceEnabled, onSubmitted, fetcher, draftOfficeFetcher } = props;
  const router = useRouter();
  const [draft, dispatch] = useReducer(scorecardDraftReducer, props.initial);
  const [savingPhotos, setSavingPhotos] = useState(0);
  const [photoSectionKey, setPhotoSectionKey] = useState<LeadershipPhotoSectionKey | null>(null);
  const [captionPhotoKey, setCaptionPhotoKey] = useState<string | null>(null);
  const [captionVoiceBusy, setCaptionVoiceBusy] = useState(false);
  const [hasEditConflict, setHasEditConflict] = useState(false);
  const [submittedResult, setSubmittedResult] = useState<{ dealId: string; scorecardId?: string } | null>(null);
  const submittedNavigationStarted = useRef(false);
  // Serialize autosaves so a slow older write can't land after a newer edit — or after the submit-delete and
  // resurrect a submitted draft. `finalized` stops saves once the draft is submitted + deleted. (Same as wizard.)
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const finalized = useRef(false);
  const conflictRecoveryInFlight = useRef(false);
  const importInFlight = useRef(false);
  // Authoritative synchronous photo count (committed + reservations still copying) — the 100-cap is enforced
  // against THIS ref, never draft.photos.length (reducer state lags a rapid next capture/import by a render).
  const photoCount = useRef(props.initial.photos.length);
  const releasedKeys = useRef<Set<string>>(new Set());
  const pendingRemovalIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (finalized.current) return;
    saveChain.current = saveChain.current
      .then(() => (finalized.current ? undefined : saveScorecardDraft(ownerKey, draft, Date.now())))
      .catch(() => undefined);
  }, [draft, ownerKey]);

  // Show the disk-backed edit immediately, then refresh only retained-photo display URLs in the background.
  // The targeted action cannot clobber locally edited category scores/comments, summary, or new evidence.
  useEffect(() => {
    const scorecardId = draft.editingScorecardId;
    if (!scorecardId) return;
    let cancelled = false;
    void getScorecard(fetcher, scorecardId)
      .then(({ scorecard }) => {
        if (cancelled) return;
        dispatch({
          type: "refreshExistingPhotoUrls",
          urlsByScorecardPhotoId: Object.fromEntries(
            scorecard.photos.map((photo) => [photo.id, photo.url ?? ""]),
          ),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draft.editingScorecardId, fetcher]);

  const average = scorecardDraftAverage(draft);
  const validation = validateScorecardDraft(draft);
  const summaryPhotos = scorecardDraftPhotosForSection(draft, SUMMARY_KEY);
  const captionPhoto = draft.photos.find((photo) => photo.key === captionPhotoKey) ?? null;
  const editingSubmitted = isEditingScorecardDraft(draft);

  // Track whether any INLINE dictation (a category comment or the Project Summary) is still recording or
  // transcribing. VoiceRecorder dispatches its transcript asynchronously on stop; submitting mid-dictation
  // builds the payload BEFORE that dispatch, then deletes the draft on success — silently losing the spoken
  // text. Keyed per recorder (a stable handler each) so one finishing can't clear another that's still busy.
  const [voiceBusyKeys, setVoiceBusyKeys] = useState<Set<string>>(() => new Set());
  const voiceBusyHandlers = useRef<Map<string, (busy: boolean) => void>>(new Map());
  const getVoiceBusyHandler = useCallback((key: string) => {
    let handler = voiceBusyHandlers.current.get(key);
    if (!handler) {
      handler = (busy: boolean) =>
        setVoiceBusyKeys((prev) => {
          if (busy === prev.has(key)) return prev;
          const next = new Set(prev);
          if (busy) next.add(key);
          else next.delete(key);
          return next;
        });
      voiceBusyHandlers.current.set(key, handler);
    }
    return handler;
  }, []);
  const anyVoiceBusy = voiceBusyKeys.size > 0;
  const navigationBusyMessage = scorecardEditorBusyMessage({
    submitting,
    savingPhotos: savingPhotos > 0,
    voiceBusy: anyVoiceBusy || captionVoiceBusy,
  });

  // Covers hardware Back and iOS swipe-to-dismiss, not only the visible header control.
  usePreventRemove(Boolean(navigationBusyMessage) && !finalized.current, () => {
    setNotice({ tone: "error", text: navigationBusyMessage ?? "Please wait before leaving this scorecard." });
  });

  // Let the removal guard commit its disabled state before routing away after a successful save.
  useEffect(() => {
    if (!submittedResult || submittedNavigationStarted.current) return;
    submittedNavigationStarted.current = true;
    onSubmitted(submittedResult.dealId, submittedResult.scorecardId);
  }, [onSubmitted, submittedResult]);

  const goBack = () => {
    if (navigationBusyMessage) {
      setNotice({ tone: "error", text: navigationBusyMessage });
      return;
    }
    router.back();
  };

  const removePhotoAndCancelUpload = (photo: ScorecardDraftPhoto) => {
    if (!releasedKeys.current.has(photo.key)) {
      releasedKeys.current.add(photo.key);
      photoCount.current -= 1;
    }
    dispatch({ type: "removePhoto", key: photo.key });
    if (isExistingScorecardDraftPhoto(photo)) return;
    const id = photo.clientUploadId;
    pendingRemovalIds.current.add(id);
    void removeQueuedUploads(ownerKey, [id])
      .then(() => pendingRemovalIds.current.delete(id))
      .catch(() => undefined);
  };

  const openPhotoCaption = (photo: ScorecardDraftPhoto) => {
    if (!isScorecardDraftPhotoCaptionEditable(draft, photo)) return;
    setCaptionPhotoKey(photo.key);
  };

  async function onCameraCapture(sectionKey: LeadershipPhotoSectionKey, shot: CapturedShot, caption: string) {
    if (importInFlight.current) {
      setNotice({ tone: "error", text: "Still saving imported photos — try again in a moment." });
      return;
    }
    if (photoCount.current >= MAX_SCORECARD_PHOTOS) {
      setNotice({ tone: "error", text: `A scorecard can hold at most ${MAX_SCORECARD_PHOTOS} photos — remove some to add more.` });
      return;
    }
    const clientUploadId = newClientUploadId();
    photoCount.current += 1; // reserve a slot synchronously; released below only if the copy fails
    setSavingPhotos((n) => n + 1);
    try {
      const exif = await withLiveGpsFallback(extractExifMetadata(shot.exif));
      const durableUri = await copyPhotoIntoDraft(ownerKey, draftId, clientUploadId, shot.uri);
      dispatch({
        type: "addPhoto",
        photo: {
          key: clientUploadId,
          uri: durableUri,
          clientUploadId,
          sectionKey,
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
      photoCount.current -= 1;
      setNotice({ tone: "error", text: "Couldn’t save that photo — please retake it." });
    } finally {
      setSavingPhotos((n) => n - 1);
    }
  }

  async function importPhotos(sectionKey: LeadershipPhotoSectionKey) {
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
      const assets = result.assets.slice(0, remaining);
      if (assets.length === 0) return;
      setSavingPhotos((n) => n + 1);
      try {
        const exifs = assets.map((a) => extractExifMetadata(a.exif as Record<string, unknown>));
        const needsLive = exifs.some((e) => e.latitude === undefined || e.longitude === undefined);
        const live = needsLive ? await getLiveGps().catch(() => null) : null;
        for (let i = 0; i < assets.length; i++) {
          const asset = assets[i];
          const clientUploadId = newClientUploadId();
          photoCount.current += 1;
          setSavingPhotos((n) => n + 1);
          try {
            const exif = mergeLiveGps(exifs[i], live);
            const durableUri = await copyPhotoIntoDraft(ownerKey, draftId, clientUploadId, asset.uri);
            dispatch({
              type: "addPhoto",
              photo: { key: clientUploadId, uri: durableUri, clientUploadId, sectionKey, caption: "", takenAt: exif.takenAt, latitude: exif.latitude, longitude: exif.longitude, addressSource: exif.addressSource, width: asset.width, height: asset.height },
            });
          } catch {
            photoCount.current -= 1;
            setNotice({ tone: "error", text: "Couldn’t import that photo — please try again." });
          } finally {
            setSavingPhotos((n) => n - 1);
          }
        }
      } finally {
        setSavingPhotos((n) => n - 1);
      }
    } finally {
      importInFlight.current = false;
    }
  }

  async function recoverEditConflict() {
    const scorecardId = draft.editingScorecardId;
    if (!scorecardId || submitting || conflictRecoveryInFlight.current) return;
    conflictRecoveryInFlight.current = true;
    setSubmitting(true);
    setNotice(null);
    try {
      const { scorecard } = await getScorecard(fetcher, scorecardId);
      const rebased = rebaseScorecardEditDraft(draft, scorecard);
      await saveChain.current.catch(() => undefined);
      await saveScorecardDraft(ownerKey, rebased.draft, Date.now());
      // Rebase may add/remove retained evidence, so reset the authoritative synchronous cap guard before
      // exposing the replacement reducer state to camera/import actions.
      photoCount.current = rebased.draft.photos.length;
      dispatch({ type: "replaceDraft", draft: rebased.draft });
      setHasEditConflict(false);
      const overflowMessage = scorecardPhotoOverflowMessage(rebased.draft.photos.length, { afterRebase: true });
      setNotice({
        tone: overflowMessage ? "error" : "success",
        text: overflowMessage ?? scorecardEditRebaseMessage(rebased),
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error
          ? `Couldn’t load the latest scorecard: ${error.message}`
          : "Couldn’t load the latest scorecard. Try again when you’re online.",
      });
    } finally {
      conflictRecoveryInFlight.current = false;
      setSubmitting(false);
    }
  }

  async function onSubmit() {
    if (submitting) return;
    if (savingPhotos > 0) {
      setNotice({ tone: "error", text: "Saving a photo — try again in a moment." });
      return;
    }
    // A dictation still recording/transcribing hasn't dispatched its transcript yet; submitting now would drop
    // that text and then delete the draft. Nudge the user to wait rather than losing the words. (The Submit
    // button is also disabled while busy — this guards the race where a tap lands as the state flips.)
    if (anyVoiceBusy || captionVoiceBusy) {
      setNotice({ tone: "error", text: "Finishing dictation — try Submit again in a moment." });
      return;
    }
    if (!validation.canSubmit) {
      setNotice({
        tone: "error",
        text: validation.tooManyPhotos
          ? scorecardPhotoOverflowMessage(draft.photos.length) ?? "Remove extra photos before saving."
          : `Score all ${CATEGORY_COUNT} categories before submitting.`,
      });
      return;
    }
    // Freeze before the marker save so a second tap or a photo edit cannot race the captured payload.
    setSubmitting(true);
    setNotice(null);
    // A failed/partial upload can leave some evidence confirmed in the gallery while the card itself still
    // needs a retry. Mark this BEFORE draining so the list screen never offers an unsafe discard that would
    // orphan confirmed evidence.
    let draftForSubmit = draft;
    const newPhotos = scorecardDraftNewPhotos(draft);
    const attemptedPhotoIds = newPhotos.map((photo) => photo.clientUploadId);
    const markedDraft = attemptedPhotoIds.length > 0
      ? markScorecardEvidenceUploadAttempted(draft, attemptedPhotoIds)
      : draft;
    if (markedDraft !== draft) {
      draftForSubmit = markedDraft;
      try {
        // Flush earlier autosaves, then durably write the safety marker + cleanup ledger before the first
        // upload can finish. This also appends photos added after an earlier attempt.
        await saveChain.current.catch(() => undefined);
        await saveScorecardDraft(ownerKey, draftForSubmit, Date.now());
      } catch {
        setNotice({ tone: "error", text: "Couldn’t prepare evidence for submission. Please try again." });
        setSubmitting(false);
        return;
      }
      dispatch({ type: "markEvidenceUploadAttempted", clientUploadIds: attemptedPhotoIds });
    }
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
      const result = await submitScorecard(fetcher, ownerKey, draftForSubmit, { draftOfficeFetcher });
      if (result.status === "photos_missing") {
        setNotice({ tone: "error", text: scorecardPhotosMissingMessage(result.missing) });
        setSubmitting(false);
        return;
      }
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
      finalized.current = true;
      await saveChain.current.catch(() => undefined);
      await deleteScorecardDraft(ownerKey, draftId).catch(() => undefined);
      setSubmitting(false);
      setSubmittedResult({ dealId: draft.dealId, scorecardId: draft.editingScorecardId });
    } catch (error) {
      const submitError = scorecardEditorSubmitError(error, editingSubmitted);
      setHasEditConflict(submitError.hasEditConflict);
      setNotice({
        tone: "error",
        text: submitError.message,
      });
      setSubmitting(false);
    }
  }

  const photosDisabled = savingPhotos > 0 || photoCount.current >= MAX_SCORECARD_PHOTOS;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader onBack={goBack} title={draft.dealName} />

      {/* Freeze the whole form once submit begins: pointerEvents="none" makes every mutation control (scores,
          text, dictation, photo add/remove/caption) a no-op so a mid-submit edit can't be silently lost when
          the draft is deleted on success. `submitting` stays true through photo upload → POST → draft deletion
          (it only resets on an error return), so the freeze holds for the entire flow; the footer Submit button
          lives outside this ScrollView and keeps showing progress. anyVoiceBusy already blocks starting a submit
          mid-dictation. */}
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        pointerEvents={submitting ? "none" : "auto"}
        style={submitting ? styles.frozen : undefined}
      >
        <Text style={styles.stepTitle}>{editingSubmitted ? "Editing submitted scorecard" : "Leadership Scorecard"}</Text>
        {notice ? (
          <Banner
            message={notice.text}
            tone={notice.tone}
            action={hasEditConflict ? { label: "Retry with my changes", onPress: () => void recoverEditConflict() } : undefined}
          />
        ) : null}

        <View style={{ gap: theme.space.md }}>
          <Field label="Project"><Text style={styles.readonly}>{draft.dealName}</Text></Field>
          {draft.projectNumber ? <Field label="Project number"><Text style={styles.readonly}>{draft.projectNumber}</Text></Field> : null}
          <Field label="Evaluator">
            {/* Display-only: the Evaluator IS whoever submits (the server stamps submittedByName from the
                field user). Seeded from the current user's name; shown read-only so an edit here can't
                silently diverge from the server-stamped evaluator. */}
            <Text style={styles.readonly}>{draft.evaluatorName?.trim() || "You"}</Text>
          </Field>
          <Field label="Project manager">
            <TextInput value={draft.pmName} onChangeText={(value) => dispatch({ type: "setHeader", field: "pmName", value })} placeholder="Name" />
          </Field>
          <Field label="Superintendent">
            <TextInput value={draft.superintendentName} onChangeText={(value) => dispatch({ type: "setHeader", field: "superintendentName", value })} placeholder="Name" />
          </Field>
        </View>

        <View style={{ gap: theme.space.sm }}>
          <View style={styles.categoryHeading}>
            <SectionLabel>Category ratings</SectionLabel>
            {/* Only truly-scored categories count — matches the submit gate + the saved draft state. */}
            <Text style={styles.scoredCount}>{scorecardDraftSectionsAnswered(draft)}/{CATEGORY_COUNT} scored</Text>
          </View>
          {FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((section) => {
            // `selected` is UNDEFINED until the evaluator actually rates this category. Never coerce it to a
            // displayed 5: showing "5/10" for an untouched row (and centering the slider) makes an unrated
            // category look scored, letting an evaluator submit without actually rating (the average would
            // stay 0 with Submit disabled and no cue). Mirror the project card: show "—" + a "tap to rate"
            // hint, and keep the score OUT of draft.scores until a tick is tapped.
            const selected = draft.scores[section.key];
            const scored = typeof selected === "number";
            const note = draft.notes[section.key] ?? "";
            const sectionPhotos = scorecardDraftPhotosForSection(draft, section.key);
            return (
              <View key={section.key} style={styles.categoryCard}>
                <View style={styles.categoryHeading}>
                  <Text style={styles.categoryTitle}>{section.title}</Text>
                  <Text style={[styles.categoryScore, !scored && styles.categoryScoreMuted]}>
                    {scored ? `${selected}/10` : "—/10"}
                  </Text>
                </View>
                {/* Center the slider at 5 for an unrated row (visual default only), but pass value={0} so no
                    tick reads as active until the user taps one — the tap is what writes the score. */}
                <ScoreSlider value={selected ?? 0} onChange={(points) => dispatch({ type: "setScore", sectionKey: section.key, points })} />
                {!scored ? <Text style={styles.tapToRate}>Tap a number to rate this category.</Text> : null}
                <Field label="Comment">
                  <TextInput
                    value={note}
                    onChangeText={(value) => dispatch({ type: "setNote", sectionKey: section.key, note: value })}
                    placeholder="Observations for this category"
                    multiline
                    style={{ minHeight: 72, textAlignVertical: "top", paddingTop: 10 }}
                  />
                  {voiceEnabled ? <VoiceRecorder onTranscript={(text) => dispatch({ type: "appendNote", sectionKey: section.key, text })} onBusyChange={getVoiceBusyHandler(`cat:${section.key}`)} /> : null}
                </Field>
                <EvidencePhotos
                  label={`Evidence photos (${sectionPhotos.length})`}
                  photos={sectionPhotos}
                  disabled={photosDisabled}
                  isCaptionEditable={(photo) => isScorecardDraftPhotoCaptionEditable(draft, photo)}
                  onEdit={openPhotoCaption}
                  onRemove={removePhotoAndCancelUpload}
                  onCamera={() => setPhotoSectionKey(section.key)}
                  onImport={() => void importPhotos(section.key)}
                />
              </View>
            );
          })}
        </View>

        <View style={{ gap: theme.space.md }}>
          <SectionLabel>Project summary</SectionLabel>
          <View style={styles.scoreWrap}>
            <Text style={styles.bigScore}>{average.toFixed(1)}<Text style={styles.bigScoreMax}> /10</Text></Text>
            <RatingBadge rating={scorecardDraftRating(draft)} label={scorecardRatingLabel(scorecardDraftRating(draft))} />
            <Text style={styles.hint}>Average of the {CATEGORY_COUNT} categories</Text>
          </View>
          <Field label="Summary">
            <TextInput
              value={draft.summary ?? ""}
              onChangeText={(value) => dispatch({ type: "setSummary", value })}
              placeholder="Overall assessment, highlights, and follow-ups"
              multiline
              style={{ minHeight: 96, textAlignVertical: "top", paddingTop: 10 }}
            />
            {voiceEnabled ? <VoiceRecorder onTranscript={(text) => dispatch({ type: "appendSummary", text })} onBusyChange={getVoiceBusyHandler("summary")} /> : null}
          </Field>

          <EvidencePhotos
            label={`Summary photos (${summaryPhotos.length})`}
            photos={summaryPhotos}
            disabled={photosDisabled}
            isCaptionEditable={(photo) => isScorecardDraftPhotoCaptionEditable(draft, photo)}
            onEdit={openPhotoCaption}
            onRemove={removePhotoAndCancelUpload}
            onCamera={() => setPhotoSectionKey(SUMMARY_KEY)}
            onImport={() => void importPhotos(SUMMARY_KEY)}
          />
        </View>
      </ScrollView>

      {validation.tooManyPhotos ? (
        <View style={styles.submitBlockBanner}>
          <Banner
            tone="error"
            message={scorecardPhotoOverflowMessage(draft.photos.length) ?? "Remove extra photos before saving."}
          />
        </View>
      ) : null}

      <View style={styles.footer}>
        <View style={styles.totalPill}>
          <Text style={styles.totalText}>{average.toFixed(1)}/10</Text>
        </View>
        <Button
          title={savingPhotos > 0 ? "Saving photo…" : anyVoiceBusy || captionVoiceBusy ? "Finishing dictation…" : editingSubmitted ? "Save changes" : "Submit ✓"}
          onPress={onSubmit}
          loading={submitting}
          disabled={!validation.canSubmit || submitting || savingPhotos > 0 || anyVoiceBusy || captionVoiceBusy}
          style={{ flex: 1 }}
        />
      </View>

      {photoSectionKey ? (
        <Suspense fallback={null}>
          <CameraCapture
            onCapture={(shot, caption) => void onCameraCapture(photoSectionKey, shot, caption)}
            onClose={() => setPhotoSectionKey(null)}
            count={scorecardDraftPhotosForSection(draft, photoSectionKey).length}
            recent={scorecardDraftPhotosForSection(draft, photoSectionKey).slice(-5).map((p) => p.uri)}
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
    </SafeAreaView>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: theme.space.xs }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function EvidencePhotos(props: {
  label: string;
  photos: ScorecardDraftPhoto[];
  disabled: boolean;
  isCaptionEditable: (photo: ScorecardDraftPhoto) => boolean;
  onEdit: (photo: ScorecardDraftPhoto) => void;
  onRemove: (photo: ScorecardDraftPhoto) => void;
  onCamera: () => void;
  onImport: () => void;
}) {
  const { label, photos, disabled, isCaptionEditable, onEdit, onRemove, onCamera, onImport } = props;
  return (
    <View style={{ gap: theme.space.sm }}>
      <SectionLabel>{label}</SectionLabel>
      <View style={styles.photoRow}>
        {photos.map((photo) => {
          const retained = isExistingScorecardDraftPhoto(photo);
          const captionEditable = isCaptionEditable(photo);
          const image = photo.uri
            ? <Image source={{ uri: photo.uri }} style={styles.thumb} />
            : <View style={styles.thumb} />;
          return (
            <View key={photo.key} style={styles.thumbWrap}>
              {!captionEditable ? (
                <View
                  accessibilityRole="image"
                  accessibilityLabel={retained
                    ? photo.caption || "Submitted evidence photo"
                    : `${photo.caption || "Evidence photo"}. Description locked after upload attempt.`}
                >
                  {image}
                  <View style={styles.thumbCaption}>
                    <Text style={styles.thumbCaptionText}>{retained ? "Submitted" : "Description locked"}</Text>
                  </View>
                </View>
              ) : (
                <Pressable
                  onPress={() => onEdit(photo)}
                  accessibilityRole="button"
                  accessibilityLabel={photo.caption.trim() ? "Photo with description. Edit description." : "Photo. Add description."}
                >
                  {image}
                  <View style={styles.thumbCaption}>
                    <Text style={styles.thumbCaptionText}>{photo.caption.trim() ? "Edit" : "Describe"}</Text>
                  </View>
                </Pressable>
              )}
              <Pressable
                onPress={() => onRemove(photo)}
                hitSlop={8}
                style={styles.thumbX}
                accessibilityRole="button"
                accessibilityLabel="Remove photo"
              >
                <Text style={styles.thumbXText}>✕</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      {photos.some(isCaptionEditable) ? (
        <Text style={styles.photoHint}>Tap a new photo to add a description or dictate it.</Text>
      ) : null}
      {photos.some((photo) => !isExistingScorecardDraftPhoto(photo) && !isCaptionEditable(photo)) ? (
        <Text style={styles.photoHint}>Uploaded descriptions are locked. Remove and re-add a photo to change its description.</Text>
      ) : null}
      <View style={styles.actions}>
        <Button title="Add photo" variant="ghost" onPress={onCamera} disabled={disabled} style={{ flex: 1 }} />
        <Button title="Import" variant="ghost" onPress={onImport} disabled={disabled} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, paddingBottom: theme.space.xxl },
  frozen: { opacity: 0.6 },
  stepTitle: { fontFamily: theme.font.bold, fontSize: 20, color: theme.color.textPrimary },
  hint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  fieldLabel: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textPrimary },
  readonly: { fontFamily: theme.font.medium, fontSize: 15, color: theme.color.textPrimary, paddingVertical: 6 },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  thumbWrap: { position: "relative" },
  thumb: { width: 64, height: 64, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  thumbX: { position: "absolute", top: -6, right: -6, backgroundColor: theme.color.brandBlack, borderRadius: 999, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  thumbXText: { color: "#fff", fontSize: 11, fontFamily: theme.font.bold },
  thumbCaption: { position: "absolute", left: 0, right: 0, bottom: 0, paddingVertical: 2, backgroundColor: "rgba(17,17,17,0.72)", alignItems: "center" },
  thumbCaptionText: { color: "#fff", fontFamily: theme.font.semibold, fontSize: 9 },
  photoHint: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  actions: { flexDirection: "row", gap: theme.space.md },
  scoreWrap: { alignItems: "center", gap: theme.space.sm, paddingVertical: theme.space.md },
  bigScore: { fontFamily: theme.font.bold, fontSize: 44, color: theme.color.textPrimary },
  bigScoreMax: { fontSize: 18, color: theme.color.textMuted },
  categoryCard: { backgroundColor: theme.color.surfaceCard, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.space.md, gap: theme.space.sm },
  categoryHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.md },
  categoryTitle: { flex: 1, fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  categoryScore: { fontFamily: theme.font.bold, fontSize: 16, color: theme.color.brandRed },
  categoryScoreMuted: { color: theme.color.textMuted },
  scoredCount: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted },
  tapToRate: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  sliderTicks: { flexDirection: "row", justifyContent: "space-between", gap: 3 },
  sliderTick: { flex: 1, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted, borderWidth: 1, borderColor: theme.color.border },
  sliderTickActive: { backgroundColor: "#FEE2E2", borderColor: "#FCA5A5" },
  sliderTickText: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textMuted },
  sliderTickTextSelected: { color: theme.color.brandRed, fontFamily: theme.font.bold },
  captionModalRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.35)" },
  captionBackdrop: { ...StyleSheet.absoluteFillObject },
  captionSheet: { gap: theme.space.md, backgroundColor: theme.color.surfaceCard, borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg, padding: theme.space.lg },
  submitBlockBanner: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm },
  footer: {
    flexDirection: "row", alignItems: "center", gap: theme.space.md,
    padding: theme.space.md, borderTopWidth: 1, borderTopColor: theme.color.border, backgroundColor: theme.color.surfaceCard,
  },
  totalPill: { backgroundColor: theme.color.surfaceMuted, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: 8 },
  totalText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.textPrimary },
});
