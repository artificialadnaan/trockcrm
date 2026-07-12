// Leadership Scorecard form. A focused screen (not the project wizard) that REUSES the shared scorecard
// machinery — the same draft model, draft-store persistence, ScoreSlider/VoiceRecorder components, the
// durable photo capture/import queue, and submitScorecard — but renders the leadership shape: an Evaluator
// (auto-filled, editable) + editable PM/Super header, the 4 categories (1-10 + dictatable comment, no
// per-category photos), and a Project Summary block (the 4-category average + a dictatable summary + a
// photos section). No signatures, no deficiencies. The project wizard at ../[draftId].tsx is untouched.

import React, { Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { theme } from "../../../../src/theme/theme";
import { useAuth } from "../../../../src/auth/AuthContext";
import { getTranscriptionConfig, type Fetcher } from "../../../../src/api/endpoints";
import { apiFetch } from "../../../../src/api/client";
import { uploadOwnerKey, newClientUploadId, removeQueuedUploads } from "../../../../src/capture/upload-queue";
import { qk } from "../../../../src/query/keys";
import { extractExifMetadata, getLiveGps, type PhotoMetadata } from "../../../../src/capture/metadata";
import type { CapturedShot } from "../../../../src/capture/CameraCapture";
import {
  FIELD_SCORECARD_LEADERSHIP_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  scorecardRatingLabel,
} from "../../../../src/scorecards/scoring";
import {
  scorecardDraftReducer,
  scorecardDraftAverage,
  scorecardDraftRating,
  scorecardDraftSummaryPhotos,
  validateScorecardDraft,
  type ScorecardDraft,
  type ScorecardDraftPhoto,
  type DraftAction,
} from "../../../../src/scorecards/draft";
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
const CATEGORY_COUNT = FIELD_SCORECARD_LEADERSHIP_SECTIONS.length;
// Server cap on total evidence photos (parseScorecardSubmission rejects photos.length > 100). Mirrored here so
// a multi-select import can't stage a batch that would only fail at submit and force manual removal.
const MAX_SCORECARD_PHOTOS = 100;

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
  const draftId = toStr(useLocalSearchParams<{ draftId: string }>().draftId);
  const { fetcher, user, activeOfficeId, token, signOut } = useAuth();
  const qc = useQueryClient();
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = uploadOwnerKey(user?.id, resolvedOfficeId ?? undefined);
  const queueFetcher = useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, { ...opts, token: token ?? undefined, officeId: resolvedOfficeId, onUnauthorized: () => void signOut() }),
    [token, resolvedOfficeId, signOut],
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
      onSubmitted={(dealId) => {
        if (user) {
          void qc.invalidateQueries({ queryKey: ["scorecards-recent", user.id] });
          void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, dealId) });
          void qc.invalidateQueries({ queryKey: qk.projectScorecards(user.id, dealId) });
        }
        router.back();
      }}
      fetcher={queueFetcher}
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
  onSubmitted: (dealId: string) => void;
  fetcher: ReturnType<typeof useAuth>["fetcher"];
}) {
  const { ownerKey, draftId, submitting, setSubmitting, notice, setNotice, voiceEnabled, onSubmitted, fetcher } = props;
  const router = useRouter();
  const [draft, dispatch] = useReducer(scorecardDraftReducer, props.initial);
  const [savingPhotos, setSavingPhotos] = useState(0);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [captionPhotoKey, setCaptionPhotoKey] = useState<string | null>(null);
  const [captionVoiceBusy, setCaptionVoiceBusy] = useState(false);
  // Serialize autosaves so a slow older write can't land after a newer edit — or after the submit-delete and
  // resurrect a submitted draft. `finalized` stops saves once the draft is submitted + deleted. (Same as wizard.)
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const finalized = useRef(false);
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

  const average = scorecardDraftAverage(draft);
  const validation = validateScorecardDraft(draft);
  const summaryPhotos = scorecardDraftSummaryPhotos(draft);
  const captionPhoto = draft.photos.find((photo) => photo.key === captionPhotoKey) ?? null;

  const goBack = () => {
    // Leaving the screen unmounts it; a photo copy still in flight would lose its pending dispatch. Block.
    if (savingPhotos > 0) {
      setNotice({ tone: "error", text: "Saving a photo — one moment…" });
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
    const id = photo.clientUploadId;
    pendingRemovalIds.current.add(id);
    void removeQueuedUploads(ownerKey, [id])
      .then(() => pendingRemovalIds.current.delete(id))
      .catch(() => undefined);
  };

  async function onCameraCapture(shot: CapturedShot, caption: string) {
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
          sectionKey: SUMMARY_KEY,
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

  async function importPhotos() {
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
              photo: { key: clientUploadId, uri: durableUri, clientUploadId, sectionKey: SUMMARY_KEY, caption: "", takenAt: exif.takenAt, latitude: exif.latitude, longitude: exif.longitude, addressSource: exif.addressSource, width: asset.width, height: asset.height },
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

  async function onSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setNotice(null);
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
      finalized.current = true;
      await saveChain.current.catch(() => undefined);
      await deleteScorecardDraft(ownerKey, draftId).catch(() => undefined);
      onSubmitted(draft.dealId);
    } catch {
      setNotice({ tone: "error", text: "Couldn’t submit the scorecard. Your work is saved — try again." });
      setSubmitting(false);
    }
  }

  const photosDisabled = savingPhotos > 0 || photoCount.current >= MAX_SCORECARD_PHOTOS;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader onBack={goBack} title={draft.dealName} />

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.stepTitle}>Leadership Scorecard</Text>
        {notice ? <Banner message={notice.text} tone={notice.tone} /> : null}

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
          <SectionLabel>Category ratings</SectionLabel>
          {FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((section) => {
            const score = draft.scores[section.key] ?? 5;
            const note = draft.notes[section.key] ?? "";
            return (
              <View key={section.key} style={styles.categoryCard}>
                <View style={styles.categoryHeading}>
                  <Text style={styles.categoryTitle}>{section.title}</Text>
                  <Text style={styles.categoryScore}>{String(score) + "/10"}</Text>
                </View>
                <ScoreSlider value={score} onChange={(points) => dispatch({ type: "setScore", sectionKey: section.key, points })} />
                <Field label="Comment">
                  <TextInput
                    value={note}
                    onChangeText={(value) => dispatch({ type: "setNote", sectionKey: section.key, note: value })}
                    placeholder="Observations for this category"
                    multiline
                    style={{ minHeight: 72, textAlignVertical: "top", paddingTop: 10 }}
                  />
                  {voiceEnabled ? <VoiceRecorder onTranscript={(text) => dispatch({ type: "appendNote", sectionKey: section.key, text })} /> : null}
                </Field>
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
            {voiceEnabled ? <VoiceRecorder onTranscript={(text) => dispatch({ type: "appendSummary", text })} /> : null}
          </Field>

          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>Photos ({summaryPhotos.length})</SectionLabel>
            <View style={styles.photoRow}>
              {summaryPhotos.map((p) => (
                <View key={p.key} style={styles.thumbWrap}>
                  <Pressable
                    onPress={() => setCaptionPhotoKey(p.key)}
                    accessibilityRole="button"
                    accessibilityLabel={p.caption.trim() ? "Photo with description. Edit description." : "Photo. Add description."}
                  >
                    <Image source={{ uri: p.uri }} style={styles.thumb} />
                    <View style={styles.thumbCaption}>
                      <Text style={styles.thumbCaptionText}>{p.caption.trim() ? "Edit" : "Describe"}</Text>
                    </View>
                  </Pressable>
                  <Pressable onPress={() => removePhotoAndCancelUpload(p)} hitSlop={8} style={styles.thumbX}>
                    <Text style={styles.thumbXText}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            {summaryPhotos.length > 0 ? <Text style={styles.photoHint}>Tap a photo to add a description or dictate it.</Text> : null}
            <View style={styles.actions}>
              <Button title="Add photo" variant="ghost" onPress={() => setCameraOpen(true)} disabled={photosDisabled} style={{ flex: 1 }} />
              <Button title="Import" variant="ghost" onPress={() => void importPhotos()} disabled={photosDisabled} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.totalPill}>
          <Text style={styles.totalText}>{average.toFixed(1)}/10</Text>
        </View>
        <Button
          title={savingPhotos > 0 ? "Saving photo…" : "Submit ✓"}
          onPress={onSubmit}
          loading={submitting}
          disabled={!validation.canSubmit || submitting || savingPhotos > 0}
          style={{ flex: 1 }}
        />
      </View>

      {cameraOpen ? (
        <Suspense fallback={null}>
          <CameraCapture
            onCapture={(shot, caption) => void onCameraCapture(shot, caption)}
            onClose={() => setCameraOpen(false)}
            count={summaryPhotos.length}
            recent={summaryPhotos.slice(-5).map((p) => p.uri)}
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, paddingBottom: theme.space.xxl },
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
  sliderTicks: { flexDirection: "row", justifyContent: "space-between", gap: 3 },
  sliderTick: { flex: 1, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted, borderWidth: 1, borderColor: theme.color.border },
  sliderTickActive: { backgroundColor: "#FEE2E2", borderColor: "#FCA5A5" },
  sliderTickText: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textMuted },
  sliderTickTextSelected: { color: theme.color.brandRed, fontFamily: theme.font.bold },
  captionModalRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(15,23,42,0.35)" },
  captionBackdrop: { ...StyleSheet.absoluteFillObject },
  captionSheet: { gap: theme.space.md, backgroundColor: theme.color.surfaceCard, borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg, padding: theme.space.lg },
  footer: {
    flexDirection: "row", alignItems: "center", gap: theme.space.md,
    padding: theme.space.md, borderTopWidth: 1, borderTopColor: theme.color.border, backgroundColor: theme.color.surfaceCard,
  },
  totalPill: { backgroundColor: theme.color.surfaceMuted, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: 8 },
  totalText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.textPrimary },
});
