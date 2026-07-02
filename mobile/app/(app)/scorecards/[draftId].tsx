import React, { Suspense, useEffect, useReducer, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { getTranscriptionConfig } from "../../../src/api/endpoints";
import { uploadOwnerKey, newClientUploadId, removeQueuedUploads } from "../../../src/capture/upload-queue";
import { qk } from "../../../src/query/keys";
import { extractExifMetadata } from "../../../src/capture/metadata";
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

const CameraCapture = React.lazy(() => import("../../../src/capture/CameraCapture"));

const SECTION_COUNT = FIELD_SCORECARD_SECTIONS.length;
const LAST_STEP = 1 + SECTION_COUNT + 2; // setup + sections + deficiencies + actions + review
// step map: 0 setup · 1..7 sections · 8 deficiencies · 9 actions · 10 review

function toStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

export default function ScorecardWizardScreen() {
  const router = useRouter();
  const draftId = toStr(useLocalSearchParams<{ draftId: string }>().draftId);
  const { fetcher, user, activeOfficeId } = useAuth();
  const qc = useQueryClient();
  const ownerKey = uploadOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? undefined);

  const [loaded, setLoaded] = useState<ScorecardDraft | null | "missing">(null);
  const [step, setStep] = useState(0);
  const [cameraSection, setCameraSection] = useState<number | null>(null);
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
    setSubmitting(false);
    setNotice(null);
    void loadScorecardDraft(ownerKey, draftId).then((d) => setLoaded(d ?? "missing"));
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
        }
        router.back();
      }}
      fetcher={fetcher}
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
  submitting: boolean;
  setSubmitting: (b: boolean) => void;
  notice: { tone: "success" | "error"; text: string } | null;
  setNotice: (n: { tone: "success" | "error"; text: string } | null) => void;
  voiceEnabled: boolean;
  onSubmitted: (dealId: string) => void;
  fetcher: ReturnType<typeof useAuth>["fetcher"];
}) {
  const { ownerKey, draftId, step, setStep, cameraSection, setCameraSection, submitting, setSubmitting, notice, setNotice, voiceEnabled, onSubmitted, fetcher } = props;
  const router = useRouter();
  const [draft, dispatch] = useReducer(scorecardDraftReducer, props.initial);
  // Serialize autosaves so a slow older write can't land after a newer edit — or after the submit-delete
  // and resurrect a submitted draft. `finalized` stops saves once the draft is submitted + deleted.
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const finalized = useRef(false);
  useEffect(() => {
    if (finalized.current) return;
    saveChain.current = saveChain.current
      .then(() => (finalized.current ? undefined : saveScorecardDraft(ownerKey, draft, Date.now())))
      .catch(() => undefined);
  }, [draft, ownerKey]);

  const total = scorecardDraftTotal(draft);
  const validation = validateScorecardDraft(draft);

  const goNext = () => setStep(Math.min(LAST_STEP, step + 1));
  const goBack = () => (step === 0 ? router.back() : setStep(step - 1));

  // Remove a photo from the draft AND cancel any already-queued upload for it (a prior offline submit may
  // have enqueued it) so a later drain can't upload evidence that's no longer part of the card. AWAIT the
  // cancellation: it must be durable before the user can tap Submit (which drains the whole owner queue) —
  // otherwise the just-removed photo could still upload. The queue mutex additionally guarantees this write
  // can't clobber photos a concurrent submit enqueues.
  const removePhotoAndCancelUpload = async (photo: ScorecardDraftPhoto) => {
    dispatch({ type: "removePhoto", key: photo.key });
    try {
      await removeQueuedUploads(ownerKey, [photo.clientUploadId]);
    } catch {
      // best-effort: if cancellation fails the server still dedupes on clientUploadId
    }
  };

  async function onCameraCapture(shot: CapturedShot, caption: string) {
    if (cameraSection === null) return;
    const sectionKey = FIELD_SCORECARD_SECTIONS[cameraSection].key;
    const clientUploadId = newClientUploadId();
    const durableUri = await copyPhotoIntoDraft(ownerKey, draftId, clientUploadId, shot.uri).catch(() => shot.uri);
    const exif = extractExifMetadata(shot.exif);
    dispatch({
      type: "addPhoto",
      photo: {
        key: clientUploadId, // stable + globally unique → survives resume; removePhoto(by key) can't collide
        uri: durableUri,
        clientUploadId,
        sectionKey,
        caption,
        takenAt: exif.takenAt ?? shot.capturedAt,
        latitude: exif.latitude,
        longitude: exif.longitude,
        width: shot.width,
        height: shot.height,
      },
    });
  }

  async function importForSection(sectionIndex: number) {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setNotice({ tone: "error", text: "Photo library permission is required to import." });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, exif: true });
    if (result.canceled) return;
    const sectionKey = FIELD_SCORECARD_SECTIONS[sectionIndex].key;
    for (const asset of result.assets) {
      const clientUploadId = newClientUploadId();
      const durableUri = await copyPhotoIntoDraft(ownerKey, draftId, clientUploadId, asset.uri).catch(() => asset.uri);
      const exif = extractExifMetadata(asset.exif as Record<string, unknown>);
      dispatch({
        type: "addPhoto",
        photo: { key: clientUploadId, uri: durableUri, clientUploadId, sectionKey, caption: "", takenAt: exif.takenAt, latitude: exif.latitude, longitude: exif.longitude, width: asset.width, height: asset.height },
      });
    }
  }

  async function onSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setNotice(null);
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

  const title =
    step === 0 ? "Setup"
    : step <= SECTION_COUNT ? FIELD_SCORECARD_SECTIONS[step - 1].title
    : step === SECTION_COUNT + 1 ? "Critical deficiencies"
    : step === SECTION_COUNT + 2 ? "Action items"
    : "Review & submit";

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
          <SetupStep draft={draft} dispatch={dispatch} />
        ) : step <= SECTION_COUNT ? (
          <SectionStep
            sectionIndex={step - 1}
            draft={draft}
            dispatch={dispatch}
            voiceEnabled={voiceEnabled}
            onAddPhoto={() => setCameraSection(step - 1)}
            onImport={() => void importForSection(step - 1)}
            onRemovePhoto={removePhotoAndCancelUpload}
          />
        ) : step === SECTION_COUNT + 1 ? (
          <DeficienciesStep draft={draft} dispatch={dispatch} />
        ) : step === SECTION_COUNT + 2 ? (
          <ActionsStep draft={draft} dispatch={dispatch} voiceEnabled={voiceEnabled} required={scorecardActionItemsRequired(draft)} />
        ) : (
          <ReviewStep draft={draft} onEditSection={(i) => setStep(1 + i)} />
        )}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.totalPill}>
          <Text style={styles.totalText}>{total}/100</Text>
        </View>
        {step < LAST_STEP ? (
          <Button title="Next →" onPress={goNext} style={{ flex: 1 }} />
        ) : (
          <Button title="Submit ✓" onPress={onSubmit} loading={submitting} disabled={!validation.canSubmit || submitting} style={{ flex: 1 }} />
        )}
      </View>

      {cameraSection !== null ? (
        <Suspense fallback={null}>
          <CameraCapture
            onCapture={(shot, caption) => void onCameraCapture(shot, caption)}
            onClose={() => setCameraSection(null)}
            count={scorecardDraftPhotosForSection(draft, FIELD_SCORECARD_SECTIONS[cameraSection].key).length}
            recent={scorecardDraftPhotosForSection(draft, FIELD_SCORECARD_SECTIONS[cameraSection].key).slice(-5).map((p) => p.uri)}
            annotatePerShot
            voiceEnabled={voiceEnabled}
          />
        </Suspense>
      ) : null}
    </SafeAreaView>
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
  sectionIndex, draft, dispatch, voiceEnabled, onAddPhoto, onImport, onRemovePhoto,
}: {
  sectionIndex: number; draft: ScorecardDraft; dispatch: React.Dispatch<DraftAction>;
  voiceEnabled: boolean; onAddPhoto: () => void; onImport: () => void;
  onRemovePhoto: (photo: ScorecardDraftPhoto) => void;
}) {
  const section = FIELD_SCORECARD_SECTIONS[sectionIndex];
  const selected = draft.scores[section.key];
  const note = draft.notes[section.key] ?? "";
  const photos = scorecardDraftPhotosForSection(draft, section.key);
  return (
    <View style={{ gap: theme.space.md }}>
      <Text style={styles.hint}>Section {sectionIndex + 1} of {SECTION_COUNT} · worth {section.maxPoints} pts</Text>
      <View style={{ gap: theme.space.sm }}>
        {section.options.map((opt) => {
          const active = selected === opt.points;
          return (
            <Pressable
              key={opt.points}
              onPress={() => dispatch({ type: "setScore", sectionKey: section.key, points: opt.points })}
              style={[styles.opt, active && styles.optActive]}
            >
              <Text style={[styles.optPts, active && styles.optPtsActive]}>{opt.points}</Text>
              <Text style={styles.optLabel}>{opt.label}</Text>
              <View style={[styles.radio, active && styles.radioActive]} />
            </Pressable>
          );
        })}
      </View>
      <Field label="Note (optional)">
        <TextInput value={note} onChangeText={(v) => dispatch({ type: "setNote", sectionKey: section.key, note: v })} placeholder="Add a note" multiline style={{ minHeight: 56, textAlignVertical: "top", paddingTop: 10 }} />
        {voiceEnabled ? (
          <VoiceRecorder onTranscript={(t) => dispatch({ type: "appendNote", sectionKey: section.key, text: t })} />
        ) : null}
      </Field>
      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Photos ({photos.length})</SectionLabel>
        <View style={styles.photoRow}>
          {photos.map((p) => (
            <View key={p.key} style={styles.thumbWrap}>
              <Image source={{ uri: p.uri }} style={styles.thumb} />
              <Pressable onPress={() => onRemovePhoto(p)} hitSlop={8} style={styles.thumbX}>
                <Text style={styles.thumbXText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
        <View style={styles.actions}>
          <Button title="Add photo" variant="ghost" onPress={onAddPhoto} style={{ flex: 1 }} />
          <Button title="Import" variant="ghost" onPress={onImport} style={{ flex: 1 }} />
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
          <Pressable key={d.key} onPress={() => dispatch({ type: "toggleDeficiency", key: d.key })} style={styles.check}>
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

function ReviewStep({ draft, onEditSection }: { draft: ScorecardDraft; onEditSection: (i: number) => void }) {
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
          return (
            <Pressable key={s.key} onPress={() => onEditSection(i)} style={styles.summaryRow}>
              <Text style={styles.summaryName} numberOfLines={1}>{s.title}</Text>
              <Text style={styles.summaryPts}>{typeof pts === "number" ? pts : "—"}</Text>
            </Pressable>
          );
        })}
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
  actions: { flexDirection: "row", gap: theme.space.md },
  check: { flexDirection: "row", alignItems: "center", gap: theme.space.md, paddingVertical: theme.space.sm, borderBottomWidth: 1, borderBottomColor: theme.color.surfaceMuted },
  box: { width: 22, height: 22, borderRadius: theme.radius.sm, borderWidth: 2, borderColor: theme.color.border, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: theme.color.brandRed, borderColor: theme.color.brandRed },
  boxCheck: { color: "#fff", fontFamily: theme.font.bold, fontSize: 13 },
  checkLabel: { flex: 1, fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary },
  scoreWrap: { alignItems: "center", gap: theme.space.sm, paddingVertical: theme.space.md },
  bigScore: { fontFamily: theme.font.bold, fontSize: 44, color: theme.color.textPrimary },
  bigScoreMax: { fontSize: 18, color: theme.color.textMuted },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: theme.space.sm, borderBottomWidth: 1, borderBottomColor: theme.color.surfaceMuted },
  summaryName: { flex: 1, fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary },
  summaryPts: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textPrimary },
  footer: {
    flexDirection: "row", alignItems: "center", gap: theme.space.md,
    padding: theme.space.md, borderTopWidth: 1, borderTopColor: theme.color.border, backgroundColor: theme.color.surfaceCard,
  },
  totalPill: { backgroundColor: theme.color.surfaceMuted, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: 8 },
  totalText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.textPrimary },
});
