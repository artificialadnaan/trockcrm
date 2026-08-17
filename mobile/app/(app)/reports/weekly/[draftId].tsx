import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePreventRemove } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ExpoImage } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { theme } from "../../../../src/theme/theme";
import { useAuth } from "../../../../src/auth/AuthContext";
import {
  createWeeklyReport,
  getTranscriptionConfig,
  getWeeklyReport,
  getWeeklyReportPhotoCandidates,
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReport,
} from "../../../../src/api/endpoints";
import type { WeeklyReportPhotoCandidate } from "../../../../src/api/types";
import { qk } from "../../../../src/query/keys";
import { newClientUploadId, uploadOwnerKey } from "../../../../src/capture/upload-queue";
import { uploadCapture } from "../../../../src/capture/upload";
import {
  extractExifMetadata,
  getLiveGps,
  hasPhotoCoords,
  mergeLiveGpsIntoExif,
} from "../../../../src/capture/metadata";
import { formatDictationAsBullets } from "../../../../src/dictation/bullets";
import {
  MAX_WEEKLY_REPORT_CAPTION_CHARS,
  MAX_WEEKLY_REPORT_PHOTOS,
  MAX_WEEKLY_REPORT_SECTION_CHARS,
  WEEKLY_REPORT_STEPS,
  isImportedWeeklyReportPhoto,
  weeklyReportDraftBlocker,
  weeklyReportDraftReducer,
  weeklyReportDraftToPatch,
  weeklyReportDraftToPhotoPayload,
  weeklyReportPhotoPreviewUri,
  weeklyReportStepAt,
  weeklyReportStepIndex,
  type WeeklyReportDraft,
  type WeeklyReportDraftAction,
  type WeeklyReportSectionKey,
  type WeeklyReportStep,
} from "../../../../src/weekly-reports/draft";
import {
  copyPhotoIntoWeeklyDraft,
  deleteWeeklyDraftPhotoFile,
  deleteWeeklyReportDraft,
  loadWeeklyReportDraft,
  saveWeeklyReportDraft,
} from "../../../../src/weekly-reports/draft-store";
import {
  weeklyReportEditorBusyMessage,
  weeklyReportStepLabel,
  weeklyReportSubmitErrorMessage,
} from "../../../../src/weekly-reports/editor-state";
import { formatWeekOf, weeklyReportFinalAction } from "../../../../src/weekly-reports/status";
import { Banner } from "../../../../src/components/Banner";
import { PhotoPickerGrid } from "../../../../src/components/PhotoPickerGrid";
import { ScreenHeader } from "../../../../src/components/ScreenHeader";
import { VoiceRecorder } from "../../../../src/components/VoiceRecorder";
import { Button, EmptyState, LoadingState, SectionLabel, TextInput } from "../../../../src/components/ui";

/**
 * The superintendent's weekly-report wizard, and the PM's review of the same report.
 *
 * The LOCAL DRAFT is the durability unit, exactly as it is for scorecards: everything the user types is
 * persisted to disk on every change and nothing is sent until they submit. That is not a preference, it is
 * the operating environment — this is written standing on a jobsite, and a wizard that PATCHed each step
 * would lose a section the moment the signal did.
 *
 * The one thing that has to exist server-side early is the report ROW, because the photo picker's
 * candidate window is derived from it. `ensureReport` creates it lazily and idempotently on
 * `clientSubmissionId`, so a retry over flaky LTE returns the same report rather than a second one.
 */
export default function WeeklyReportWizardScreen() {
  const router = useRouter();
  const { draftId: rawDraftId } = useLocalSearchParams<{ draftId: string }>();
  const draftId = String(rawDraftId ?? "");
  const { fetcher, user, activeOfficeId } = useAuth();
  const ownerKey = uploadOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? undefined);

  const [loaded, setLoaded] = useState<WeeklyReportDraft | null | "missing">(null);

  useEffect(() => {
    if (!ownerKey || !draftId) return;
    setLoaded(null);
    // Guard against a slow read for a PREVIOUS draftId resolving last and seeding the wizard with the
    // wrong draft — ignore any resolution after this effect has been superseded.
    let cancelled = false;
    void loadWeeklyReportDraft(ownerKey, draftId)
      .then((draft) => {
        if (!cancelled) setLoaded(draft ?? "missing");
      })
      .catch(() => {
        // A read failure must not strand the screen on "Loading…" — resolve to not-found so the user gets
        // a clear message and a way back.
        if (!cancelled) setLoaded("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [ownerKey, draftId]);

  if (loaded === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Weekly report" />
        <LoadingState label="Loading…" />
      </SafeAreaView>
    );
  }
  if (loaded === "missing") {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Weekly report" />
        <EmptyState title="Draft not found" subtitle="It may have been submitted or discarded." />
      </SafeAreaView>
    );
  }

  // `key` remounts the reducer host when a different draft arrives, so no state leaks between drafts.
  return <Wizard key={draftId} initial={loaded} ownerKey={ownerKey!} draftId={draftId} />;
}

type Notice = { tone: "success" | "error"; text: string };

function Wizard({
  initial,
  ownerKey,
  draftId,
}: {
  initial: WeeklyReportDraft;
  ownerKey: string;
  draftId: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const { fetcher, user } = useAuth();
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - theme.space.lg * 2 - 8 * 2) / 3);

  const [draft, dispatch] = useReducer(weeklyReportDraftReducer, initial);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [voiceBusyKeys, setVoiceBusyKeys] = useState<Set<string>>(() => new Set());
  // The photos step is two views over one selection: pick from the project's window, then caption and
  // order what was picked. Split for the same reason ReportBuilder splits them — a virtualized grid and a
  // list of multi-line text inputs cannot share one scroll container without nesting two VirtualizedLists.
  const [photoView, setPhotoView] = useState<"pick" | "arrange">("pick");
  const [finished, setFinished] = useState(false);

  // Serialize autosaves so a slow older write cannot land after a newer edit — or after the submit-delete
  // and resurrect a report that was already filed. `finalized` stops saves once the draft is gone.
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const finalized = useRef(false);
  // `importing` is React state and does not update before a second rapid tap re-reads it, so a ref is what
  // actually bars the double-tap before the picker opens.
  const importInFlight = useRef(false);

  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });
  const voiceEnabled = transcribeConfig.data?.configured ?? false;

  useEffect(() => {
    if (finalized.current) return;
    saveChain.current = saveChain.current
      .then(() => (finalized.current ? undefined : saveWeeklyReportDraft(ownerKey, draft, Date.now())))
      .catch(() => undefined);
  }, [draft, ownerKey]);

  const anyVoiceBusy = voiceBusyKeys.size > 0;
  const busyMessage = weeklyReportEditorBusyMessage({
    submitting,
    importing,
    voiceBusy: anyVoiceBusy,
  });
  // Covers the hardware Back button and iOS swipe-to-dismiss, not just the header chevron.
  usePreventRemove(Boolean(busyMessage) && !finished, () => {
    setNotice({ tone: "error", text: busyMessage ?? "Please wait before leaving this report." });
  });

  // Each recorder is tracked independently: a transcript arrives asynchronously AFTER recording stops, so
  // leaving or submitting in that window would silently discard what was said.
  const voiceBusyHandlers = useRef<Map<string, (busy: boolean) => void>>(new Map());
  const getVoiceBusyHandler = useCallback((key: string) => {
    let handler = voiceBusyHandlers.current.get(key);
    if (!handler) {
      handler = (busy: boolean) =>
        setVoiceBusyKeys((previous) => {
          if (busy === previous.has(key)) return previous;
          const next = new Set(previous);
          if (busy) next.add(key);
          else next.delete(key);
          return next;
        });
      voiceBusyHandlers.current.set(key, handler);
    }
    return handler;
  }, []);

  /**
   * Make sure a server report exists, returning its id.
   *
   * Idempotent on `clientSubmissionId`, which was stamped once when the local draft was created — so a
   * create whose response was lost returns the SAME report on the next attempt instead of a duplicate for
   * the week. A report opened for review already has an id and never reaches the POST.
   */
  const ensureReport = useCallback(async (): Promise<string> => {
    if (draft.reportId) return draft.reportId;
    const { report } = await createWeeklyReport(fetcher, {
      clientSubmissionId: draft.clientSubmissionId,
      weeklyReportProjectId: draft.weeklyReportProjectId,
      weekOf: draft.weekOf,
    });
    dispatch({ type: "setReportId", reportId: report.id });
    return report.id;
  }, [draft.reportId, draft.clientSubmissionId, draft.weeklyReportProjectId, draft.weekOf, fetcher]);

  // The report row has to exist before the picker can ask what photos fall in its window, so create it
  // when the user reaches the photos step rather than at submit. Failure is left silent here: the step
  // renders its own "couldn't load" state, and an error banner on arrival would fire for anyone who
  // simply walked through the wizard while offline.
  const onPhotosStep = draft.step === "photos";
  useEffect(() => {
    if (!onPhotosStep || draft.reportId) return;
    void ensureReport().catch(() => undefined);
  }, [onPhotosStep, draft.reportId, ensureReport]);

  const candidates = useQuery({
    queryKey: ["weekly-report-candidates", draft.reportId ?? "none"],
    queryFn: () => getWeeklyReportPhotoCandidates(fetcher, draft.reportId!),
    enabled: onPhotosStep && Boolean(draft.reportId),
  });

  // Presigned preview URLs expire (6h), so a draft resumed the next morning holds stale ones. Refreshing
  // from the candidate read is targeted — it only ever rewrites `remoteUrl`, never a caption, the order,
  // or anything else the user may be editing while the request is in flight.
  useEffect(() => {
    const photos = candidates.data?.photos;
    if (!photos?.length) return;
    const urlsByFileId: Record<string, string | null> = {};
    for (const photo of photos) urlsByFileId[photo.fileId] = photo.thumbnailUrl;
    dispatch({ type: "refreshPhotoUrls", urlsByFileId });
  }, [candidates.data]);

  function setStep(step: WeeklyReportStep) {
    setNotice(null);
    setPhotoView("pick");
    dispatch({ type: "setStep", step });
  }

  const stepIndex = weeklyReportStepIndex(draft.step);

  function goBack() {
    if (draft.step === "photos" && photoView === "arrange") {
      setPhotoView("pick");
      return;
    }
    if (stepIndex === 0) {
      router.back();
      return;
    }
    setStep(weeklyReportStepAt(stepIndex - 1));
  }

  function goNext() {
    if (draft.step === "photos" && photoView === "pick" && draft.photos.length > 0) {
      setNotice(null);
      setPhotoView("arrange");
      return;
    }
    setStep(weeklyReportStepAt(stepIndex + 1));
  }

  /**
   * Import from the device.
   *
   * Uploaded through the ordinary field photo path, so the picked shot becomes a real `files` row on the
   * deal and appears in the project gallery like any other capture — the report links to it by file id,
   * exactly as it links to a photo taken on site. Done synchronously rather than through the durable
   * upload queue because the report needs the resulting fileId NOW to attach it; the durable local copy
   * taken first is what protects the pick if the upload fails or the app is killed.
   */
  async function importPhotos() {
    if (importInFlight.current || submitting) return;
    importInFlight.current = true;
    setImporting(true);
    setNotice(null);
    try {
      const reportId = await ensureReport();
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setNotice({ tone: "error", text: "Photo library permission is required to import." });
        return;
      }
      const remaining = MAX_WEEKLY_REPORT_PHOTOS - draft.photos.length;
      if (remaining <= 0) {
        setNotice({
          tone: "error",
          text: `A weekly report holds at most ${MAX_WEEKLY_REPORT_PHOTOS} photos — remove some to import more.`,
        });
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
      // Defensive: never exceed the remaining slots even if a platform ignores selectionLimit.
      const assets = result.assets.slice(0, remaining);
      if (assets.length === 0) return;

      // Fetch live GPS ONCE for the whole batch and reuse it (mirrors the Capture screen). Per asset it
      // would serialise an up-to-8s lookup for every coordless photo and freeze a large indoor import.
      const exifs = assets.map((asset) => extractExifMetadata(asset.exif as Record<string, unknown>));
      const needsLive = exifs.some((e) => !hasPhotoCoords(e));
      const live = needsLive ? await getLiveGps().catch(() => null) : null;

      let failures = 0;
      for (let i = 0; i < assets.length; i += 1) {
        const asset = assets[i];
        const clientUploadId = newClientUploadId();
        // Location only — never the live fix's `takenAt`, which would restamp the photo to now and drop
        // it out of the very window this report's picker filters on.
        const metadata = mergeLiveGpsIntoExif(exifs[i], live);
        try {
          // Durable-copy BEFORE the upload: a library uri expires, and the copy is what a resumed draft
          // renders (and what draft-store rebases after an iOS container rotation).
          const localUri = await copyPhotoIntoWeeklyDraft(ownerKey, draftId, clientUploadId, asset.uri);
          dispatch({
            type: "addPhoto",
            photo: {
              key: clientUploadId,
              fileId: null,
              caption: "",
              originalDescription: null,
              remoteUrl: null,
              localUri,
              clientUploadId,
              takenAt: metadata.takenAt ?? null,
              width: asset.width,
              height: asset.height,
              latitude: metadata.latitude,
              longitude: metadata.longitude,
              addressSource: metadata.addressSource,
            },
          });
          const photo = await uploadCapture(fetcher, {
            uri: localUri,
            width: asset.width,
            height: asset.height,
            target: { dealId: draft.dealId },
            category: null,
            caption: null,
            // Tagged so the gallery shows where an imported photo came from; the report's own caption is
            // a separate column and is never written to the file.
            tags: ["weekly-report"],
            metadata,
            clientUploadId,
          });
          dispatch({
            type: "resolvePhotoUpload",
            key: clientUploadId,
            fileId: photo.id,
            remoteUrl: photo.imageUrl,
          });
        } catch {
          failures += 1;
          // Leave the photo on the draft with no fileId: `weeklyReportDraftBlocker` reports it as still
          // uploading and blocks submit, which is honest — removing it silently would drop a photo the
          // user chose without ever telling them.
        }
      }
      if (failures > 0) {
        setNotice({
          tone: "error",
          text: `${failures} photo${failures === 1 ? "" : "s"} couldn’t upload. Remove ${failures === 1 ? "it" : "them"} or try again with a better signal.`,
        });
      } else if (draft.reportId || reportId) {
        void qc.invalidateQueries({ queryKey: ["weekly-report-candidates", reportId] });
        if (user) void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, draft.dealId) });
      }
    } catch (error) {
      setNotice({ tone: "error", text: weeklyReportSubmitErrorMessage(error) });
    } finally {
      setImporting(false);
      importInFlight.current = false; // released on every exit: denied, cancelled, capped, failed, done
    }
  }

  function removePhoto(key: string) {
    const photo = draft.photos.find((p) => p.key === key);
    dispatch({ type: "removePhoto", key });
    // Reclaim the durable copy of an import so a long-lived draft does not leak files on disk. The
    // uploaded gallery photo itself is left alone — it is a real capture on the deal now, and deleting a
    // project photo because it came off a report draft is not this screen's call.
    if (photo?.localUri) void deleteWeeklyDraftPhotoFile(photo.localUri);
  }

  function toggleCandidate(candidate: WeeklyReportPhotoCandidate) {
    const existing = draft.photos.find((photo) => photo.fileId === candidate.fileId);
    if (existing) {
      removePhoto(existing.key);
      return;
    }
    if (draft.photos.length >= MAX_WEEKLY_REPORT_PHOTOS) {
      setNotice({
        tone: "error",
        text: `A weekly report holds at most ${MAX_WEEKLY_REPORT_PHOTOS} photos.`,
      });
      return;
    }
    dispatch({
      type: "addPhoto",
      photo: {
        key: candidate.fileId,
        fileId: candidate.fileId,
        // Seeded from the capture description, then owned by the report. Editing it here never writes
        // back to the file — that separation is enforced by the schema, not by this screen.
        caption: candidate.caption ?? "",
        originalDescription: candidate.originalDescription,
        remoteUrl: candidate.thumbnailUrl,
        localUri: null,
        takenAt: candidate.takenAt,
      },
    });
  }

  const finalAction = weeklyReportFinalAction(draft);

  async function submit() {
    if (submitting) return;
    const blocker = weeklyReportDraftBlocker(draft);
    if (blocker) {
      setNotice({ tone: "error", text: blocker });
      return;
    }
    const patch = weeklyReportDraftToPatch(draft);
    if (!patch) {
      setNotice({ tone: "error", text: "Check the completion % and weather delay values." });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const reportId = await ensureReport();
      // Content, then photos, then the transition — in that order so the PM's queue never receives a
      // report whose text or photo set is only half-written. Every step is retryable: the local draft is
      // untouched until the transition succeeds.
      await updateWeeklyReport(fetcher, reportId, patch);
      await replaceWeeklyReportPhotos(fetcher, reportId, weeklyReportDraftToPhotoPayload(draft));
      // `transitionTo` is null when the report is ALREADY in the state this button would ask for — a PM
      // fixing a caption on an approved report. The ladder has no self-transition, so asking anyway would
      // 409 on work that saved perfectly well.
      if (finalAction.transitionTo) {
        const { report } = await transitionWeeklyReport(fetcher, reportId, finalAction.transitionTo);
        // Record where the report landed BEFORE anything that can still fail. Everything after this point
        // is local cleanup, and if the disk delete throws the user is left holding a draft whose report has
        // already moved — a retry would then ask for the same transition again and 409 on work that
        // succeeded. With the status recorded, the retry reads "Save changes" and does the right thing.
        dispatch({ type: "setServerStatus", status: report.status });
      }

      // Stop autosaves BEFORE the delete, or a save already queued behind this one resurrects the draft.
      finalized.current = true;
      await saveChain.current.catch(() => undefined);
      await deleteWeeklyReportDraft(ownerKey, draftId);
      setFinished(true);
      if (user) void qc.invalidateQueries({ queryKey: ["weekly-report-assignments", user.id] });
    } catch (error) {
      finalized.current = false;
      setNotice({ tone: "error", text: weeklyReportSubmitErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  }

  // Navigate only once a render has happened with the removal guard disabled. Calling router.back inside
  // the async submit would race usePreventRemove and could be blocked or double-pop.
  useEffect(() => {
    if (finished) router.back();
  }, [finished, router]);

  const title = draft.mode === "review" ? "Review report" : "Weekly report";
  const blocker = weeklyReportDraftBlocker(draft);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader
        onBack={goBack}
        title={title}
        right={<Text style={styles.stepCounter}>{weeklyReportStepLabel(stepIndex, WEEKLY_REPORT_STEPS.length)}</Text>}
      />
      <View style={styles.subheader}>
        <Text style={styles.projectName} numberOfLines={1}>
          {draft.projectName}
        </Text>
        <Text style={styles.weekOf}>Week of {formatWeekOf(draft.weekOf)}</Text>
      </View>
      {notice ? (
        <View style={styles.noticeWrap}>
          {/* Coloured by tone, not just shown: the same banner slot carries "this photo failed to upload"
              and "please wait", and rendering a hold in the failure palette teaches people to ignore red. */}
          <Banner message={notice.text} tone={notice.tone} />
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={8}
      >
        {draft.step === "photos" && photoView === "pick" ? (
          <PhotoPickerStep
            candidates={candidates.data?.photos ?? []}
            loading={candidates.isLoading}
            failed={candidates.isError}
            selectedFileIds={new Set(draft.photos.map((photo) => photo.fileId).filter(Boolean) as string[])}
            selectedCount={draft.photos.length}
            cellSize={cell}
            importing={importing}
            weekOf={draft.weekOf}
            onToggle={toggleCandidate}
            onImport={() => void importPhotos()}
          />
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {draft.step === "work" ? (
              <SectionStep
                sectionKey="workCompleted"
                label="Work completed / in progress"
                hint="What the crew got done this week. This is the section the client reads first."
                placeholder="e.g. Poured the north slab. Balcony mock-up complete."
                value={draft.workCompleted}
                voiceEnabled={voiceEnabled}
                onBusyChange={getVoiceBusyHandler("workCompleted")}
                dispatch={dispatch}
              />
            ) : null}

            {draft.step === "lookahead" ? (
              <SectionStep
                sectionKey="nextWeekLookAhead"
                label="Next week look ahead"
                hint="What is planned. Optional, but it is the section clients ask about."
                placeholder="e.g. Start unit framing. Roof drain rough-in."
                value={draft.nextWeekLookAhead}
                voiceEnabled={voiceEnabled}
                onBusyChange={getVoiceBusyHandler("nextWeekLookAhead")}
                dispatch={dispatch}
              />
            ) : null}

            {draft.step === "issues" ? (
              <SectionStep
                sectionKey="issuesConcerns"
                label="Issues / concerns"
                hint="Anything the client needs to know about or decide on. Leave blank if there is nothing."
                placeholder="e.g. Awaiting permit for the east elevation."
                value={draft.issuesConcerns}
                voiceEnabled={voiceEnabled}
                onBusyChange={getVoiceBusyHandler("issuesConcerns")}
                dispatch={dispatch}
              />
            ) : null}

            {draft.step === "numbers" ? (
              <View style={{ gap: theme.space.md }}>
                <SectionLabel>Completion %</SectionLabel>
                <Text style={styles.hint}>
                  Whole project, 0–100. Prefilled from the last report — correct it if it moved.
                </Text>
                <TextInput
                  value={draft.completionPercent}
                  onChangeText={(value) =>
                    dispatch({ type: "setNumber", key: "completionPercent", value })
                  }
                  placeholder="e.g. 12.5"
                  keyboardType="decimal-pad"
                  accessibilityLabel="Completion percent"
                />

                <SectionLabel>Weather delay days</SectionLabel>
                <Text style={styles.hint}>Days lost to weather so far, cumulative for the project.</Text>
                <TextInput
                  value={draft.weatherDelayDays}
                  onChangeText={(value) =>
                    dispatch({ type: "setNumber", key: "weatherDelayDays", value })
                  }
                  placeholder="e.g. 2"
                  keyboardType="number-pad"
                  accessibilityLabel="Weather delay days"
                />
                {/* Remaining weeks is deliberately absent: the server computes it from the projected
                    duration and the start date at submit, and a second answer typed here could only
                    disagree with the one the client's report actually prints. */}
              </View>
            ) : null}

            {draft.step === "photos" ? (
              <PhotoArrangeStep
                draft={draft}
                voiceEnabled={voiceEnabled}
                getVoiceBusyHandler={getVoiceBusyHandler}
                dispatch={dispatch}
                onRemove={removePhoto}
                onBackToPicker={() => setPhotoView("pick")}
                busy={Boolean(busyMessage)}
              />
            ) : null}

            {draft.step === "review" ? (
              <ReviewStep draft={draft} onJumpTo={setStep} />
            ) : null}
          </ScrollView>
        )}
      </KeyboardAvoidingView>

      <View style={styles.footer}>
        {draft.step === "review" && blocker ? <Text style={styles.blocker}>{blocker}</Text> : null}
        {draft.step === "review" ? (
          <Button
            title={finalAction.label}
            onPress={() => void submit()}
            loading={submitting}
            disabled={Boolean(busyMessage) || Boolean(blocker)}
          />
        ) : (
          <Button
            title={draft.step === "photos" && photoView === "pick" ? "Captions & order" : "Next"}
            onPress={goNext}
            disabled={Boolean(busyMessage)}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

/** One of the three dictatable prose sections. Identical shape for all three — only the copy differs. */
function SectionStep({
  sectionKey,
  label,
  hint,
  placeholder,
  value,
  voiceEnabled,
  onBusyChange,
  dispatch,
}: {
  sectionKey: WeeklyReportSectionKey;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  voiceEnabled: boolean;
  onBusyChange: (busy: boolean) => void;
  dispatch: React.Dispatch<WeeklyReportDraftAction>;
}) {
  return (
    <View style={{ gap: theme.space.md }}>
      <SectionLabel>{label}</SectionLabel>
      <Text style={styles.hint}>{hint}</Text>
      <TextInput
        value={value}
        onChangeText={(text) => dispatch({ type: "setSection", key: sectionKey, value: text })}
        placeholder={placeholder}
        multiline
        maxLength={MAX_WEEKLY_REPORT_SECTION_CHARS}
        style={styles.sectionInput}
        accessibilityLabel={label}
      />
      {voiceEnabled ? (
        <VoiceRecorder
          label="🎤 Dictate"
          onBusyChange={onBusyChange}
          onTranscript={(text) =>
            // Formatted into dash bullets on the way in, because that is how the report prints. It lands
            // in this same editable box, so anything the split got wrong is one tap from being fixed.
            dispatch({ type: "appendSection", key: sectionKey, text: formatDictationAsBullets(text) })
          }
        />
      ) : null}
    </View>
  );
}

function PhotoPickerStep({
  candidates,
  loading,
  failed,
  selectedFileIds,
  selectedCount,
  cellSize,
  importing,
  weekOf,
  onToggle,
  onImport,
}: {
  candidates: WeeklyReportPhotoCandidate[];
  loading: boolean;
  failed: boolean;
  selectedFileIds: Set<string>;
  selectedCount: number;
  cellSize: number;
  importing: boolean;
  weekOf: string;
  onToggle: (candidate: WeeklyReportPhotoCandidate) => void;
  onImport: () => void;
}) {
  const byFileId = new Map(candidates.map((candidate) => [candidate.fileId, candidate]));
  const pickable = candidates.map((candidate) => ({
    id: candidate.fileId,
    displayName: candidate.caption?.trim() || "photo",
    imageUrl: candidate.thumbnailUrl,
  }));

  const header = (
    <View style={{ gap: theme.space.sm, marginBottom: theme.space.md }}>
      <SectionLabel>{selectedCount} selected</SectionLabel>
      <Text style={styles.hint}>
        {/* Say WHICH photos these are. The window is anchored on the report's week, not on today, so a
            report filed late shows the week it covers — which is surprising unless it is stated. */}
        Photos from the two weeks ending {formatWeekOf(weekOf)}. Anything used on an earlier report is
        marked.
      </Text>
      <Button title="Import from device" variant="ghost" onPress={onImport} loading={importing} />
    </View>
  );

  if (loading) return <LoadingState label="Loading photos…" />;
  if (failed) {
    return (
      <View style={styles.body}>
        {header}
        <EmptyState
          title="Couldn’t load photos"
          subtitle="Go back and forward again once you have a signal, or import from the device."
        />
      </View>
    );
  }
  if (candidates.length === 0) {
    return (
      <View style={styles.body}>
        {header}
        <EmptyState
          title="No photos for this week"
          subtitle="Nothing was captured on this project in the two weeks ending on the report date. You can still import from the device."
        />
      </View>
    );
  }

  return (
    <PhotoPickerGrid
      photos={pickable}
      selected={selectedFileIds}
      onToggle={(id) => {
        const candidate = byFileId.get(id);
        if (candidate) onToggle(candidate);
      }}
      cellSize={cellSize}
      disabled={importing}
      header={header}
      getAccessibilityLabel={(photo, isSelected) => {
        const candidate = byFileId.get(photo.id);
        const used = candidate?.alreadyUsedOn
          ? `, already used on the week of ${formatWeekOf(candidate.alreadyUsedOn)}`
          : "";
        return `${isSelected ? "Deselect" : "Select"} ${photo.displayName}${used}`;
      }}
      renderBadge={(photo) => {
        const candidate = byFileId.get(photo.id);
        // Shown rather than hidden: re-using a photo is sometimes right (a defect photographed last week
        // that is now fixed), so this makes it a choice instead of an accident.
        if (!candidate?.alreadyUsedOn) return null;
        return (
          <Text style={styles.usedBadge} numberOfLines={1}>
            Used {formatWeekOf(candidate.alreadyUsedOn)}
          </Text>
        );
      }}
    />
  );
}

function PhotoArrangeStep({
  draft,
  voiceEnabled,
  getVoiceBusyHandler,
  dispatch,
  onRemove,
  onBackToPicker,
  busy,
}: {
  draft: WeeklyReportDraft;
  voiceEnabled: boolean;
  getVoiceBusyHandler: (key: string) => (busy: boolean) => void;
  dispatch: React.Dispatch<WeeklyReportDraftAction>;
  onRemove: (key: string) => void;
  onBackToPicker: () => void;
  /** True while dictation or a submit is in flight — see the Choose-photos comment below. */
  busy: boolean;
}) {
  if (draft.photos.length === 0) {
    return (
      <View style={{ gap: theme.space.md }}>
        <EmptyState
          title="No photos selected"
          subtitle="A weekly report can go out without photos, but the client page and PDF are mostly pictures."
        />
        {/* Disabled while dictation is in flight: flipping back to the picker unmounts every caption
          recorder, and the transcript then lands on a component that is gone. usePreventRemove guards
          leaving the SCREEN, not this in-screen view switch. */}
      <Button title="Choose photos" variant="ghost" onPress={onBackToPicker} disabled={busy} />
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space.md }}>
      <SectionLabel>
        {draft.photos.length} photo{draft.photos.length === 1 ? "" : "s"}
      </SectionLabel>
      {/* The order here IS the print order — the server stores array position, ignoring any index the
          client sends, so what is arranged on this screen is what the client receives. */}
      <Text style={styles.hint}>Photos print in this order — use ↑ ↓ to rearrange.</Text>
      {/* Disabled while dictation is in flight: flipping back to the picker unmounts every caption
          recorder, and the transcript then lands on a component that is gone. usePreventRemove guards
          leaving the SCREEN, not this in-screen view switch. */}
      <Button title="Choose photos" variant="ghost" onPress={onBackToPicker} disabled={busy} />

      {draft.photos.map((photo, index) => {
        const uri = weeklyReportPhotoPreviewUri(photo);
        return (
          <View key={photo.key} style={styles.photoRow}>
            {uri ? (
              <ExpoImage
                source={{ uri }}
                style={styles.photoThumb}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={photo.key}
                transition={80}
              />
            ) : (
              <View style={[styles.photoThumb, styles.photoPlaceholder]} />
            )}
            <View style={{ flex: 1, gap: theme.space.sm }}>
              <TextInput
                value={photo.caption}
                onChangeText={(caption) => dispatch({ type: "setPhotoCaption", key: photo.key, caption })}
                placeholder="Caption for the client"
                multiline
                maxLength={MAX_WEEKLY_REPORT_CAPTION_CHARS}
                style={styles.captionInput}
                accessibilityLabel={`Caption for photo ${index + 1}`}
              />
              {photo.originalDescription && photo.originalDescription !== photo.caption ? (
                // Says where the caption came from and, implicitly, that editing it is safe: the capture
                // description on the file itself never changes.
                <Text style={styles.hint} numberOfLines={2}>
                  Captured as “{photo.originalDescription}”
                </Text>
              ) : null}
              {!photo.fileId ? <Text style={styles.uploading}>Uploading…</Text> : null}
              {voiceEnabled ? (
                <VoiceRecorder
                  label="🎤 Dictate caption"
                  onBusyChange={getVoiceBusyHandler(`caption:${photo.key}`)}
                  onTranscript={(text) =>
                    dispatch({ type: "appendPhotoCaption", key: photo.key, text })
                  }
                />
              ) : null}
              <Pressable
                onPress={() => onRemove(photo.key)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${index + 1} from this report${isImportedWeeklyReportPhoto(photo) ? ", it stays in the project gallery" : ""}`}
              >
                <Text style={styles.removeLink}>Remove</Text>
              </Pressable>
            </View>
            <View style={styles.reorderColumn}>
              <Text style={styles.reorderPosition}>
                {index + 1}/{draft.photos.length}
              </Text>
              <Pressable
                onPress={() => dispatch({ type: "movePhoto", key: photo.key, direction: -1 })}
                disabled={index === 0}
                hitSlop={2}
                accessibilityRole="button"
                // Leads with the POSITION because captions are not unique — two photos routinely have the
                // same one, or none — and position is also what the control changes.
                accessibilityLabel={`Move photo ${index + 1} of ${draft.photos.length} earlier`}
                style={({ pressed }) => [
                  styles.reorderButton,
                  index === 0 && styles.reorderButtonDisabled,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Ionicons
                  name="chevron-up"
                  size={18}
                  color={index === 0 ? theme.color.textMuted : theme.color.brandRed}
                />
              </Pressable>
              <Pressable
                onPress={() => dispatch({ type: "movePhoto", key: photo.key, direction: 1 })}
                disabled={index === draft.photos.length - 1}
                hitSlop={2}
                accessibilityRole="button"
                accessibilityLabel={`Move photo ${index + 1} of ${draft.photos.length} later`}
                style={({ pressed }) => [
                  styles.reorderButton,
                  index === draft.photos.length - 1 && styles.reorderButtonDisabled,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Ionicons
                  name="chevron-down"
                  size={18}
                  color={
                    index === draft.photos.length - 1 ? theme.color.textMuted : theme.color.brandRed
                  }
                />
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function ReviewStep({
  draft,
  onJumpTo,
}: {
  draft: WeeklyReportDraft;
  onJumpTo: (step: WeeklyReportStep) => void;
}) {
  return (
    <View style={{ gap: theme.space.lg }}>
      <ReviewSection
        label="Work completed / in progress"
        value={draft.workCompleted}
        onEdit={() => onJumpTo("work")}
      />
      <ReviewSection
        label="Next week look ahead"
        value={draft.nextWeekLookAhead}
        onEdit={() => onJumpTo("lookahead")}
      />
      <ReviewSection
        label="Issues / concerns"
        value={draft.issuesConcerns}
        onEdit={() => onJumpTo("issues")}
      />
      <ReviewSection
        label="Progress"
        value={[
          draft.completionPercent.trim() ? `${draft.completionPercent.trim()}% complete` : null,
          draft.weatherDelayDays.trim() ? `${draft.weatherDelayDays.trim()} weather delay days` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        onEdit={() => onJumpTo("numbers")}
      />
      <ReviewSection
        label="Photos"
        value={`${draft.photos.length} photo${draft.photos.length === 1 ? "" : "s"}`}
        onEdit={() => onJumpTo("photos")}
      />
      <Text style={styles.hint}>
        {draft.mode === "review"
          ? "Approving marks this report ready to send to the client."
          : "This goes to the project manager for review. Nothing reaches the client until they send it."}
      </Text>
    </View>
  );
}

function ReviewSection({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: string;
  onEdit: () => void;
}) {
  return (
    <View style={{ gap: theme.space.sm }}>
      <View style={styles.reviewHeader}>
        <SectionLabel>{label}</SectionLabel>
        <Pressable onPress={onEdit} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Edit ${label}`}>
          <Text style={styles.editLink}>Edit</Text>
        </Pressable>
      </View>
      <Text style={value.trim() ? styles.reviewValue : styles.reviewEmpty}>
        {value.trim() || "Not filled in"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  subheader: {
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.md,
    paddingBottom: theme.space.sm,
  },
  projectName: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.textPrimary },
  weekOf: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  stepCounter: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.textMuted },
  noticeWrap: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  hint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  sectionInput: { minHeight: 180, textAlignVertical: "top", paddingTop: 10 },
  captionInput: { minHeight: 64, textAlignVertical: "top", paddingTop: 10 },
  photoRow: { flexDirection: "row", gap: theme.space.md, alignItems: "flex-start" },
  photoThumb: {
    width: 72,
    height: 72,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surfaceMuted,
  },
  photoPlaceholder: { borderWidth: 1, borderColor: theme.color.border },
  uploading: { fontFamily: theme.font.medium, fontSize: 12, color: theme.color.warning },
  removeLink: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.danger },
  usedBadge: {
    fontFamily: theme.font.medium,
    fontSize: 10,
    color: theme.color.textInverse,
    backgroundColor: theme.color.overlay,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 2,
    textAlign: "center",
  },
  // The gap must stay WIDER than twice the buttons' hitSlop, or the two slop rectangles overlap and the
  // later sibling (down) claims the shared band — so a tap aimed at the bottom of "up" moves the photo
  // DOWN. gap 8 vs hitSlop 2 leaves 4pt of clearance.
  reorderColumn: { alignItems: "center", gap: theme.space.sm, paddingTop: 2 },
  reorderPosition: { fontFamily: theme.font.semibold, fontSize: 11, color: theme.color.textMuted },
  reorderButton: {
    // 44x40 + 2pt slop each side = a 48x44 target, the iOS minimum. These get used in gloves.
    width: 44,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  reorderButtonDisabled: { opacity: 0.4 },
  reviewHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  editLink: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  reviewValue: { fontFamily: theme.font.body, fontSize: 15, color: theme.color.textPrimary },
  reviewEmpty: { fontFamily: theme.font.body, fontSize: 15, color: theme.color.textMuted },
  blocker: {
    fontFamily: theme.font.body,
    fontSize: 13,
    color: theme.color.danger,
    marginBottom: theme.space.sm,
    textAlign: "center",
  },
  footer: {
    padding: theme.space.lg,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surfaceCard,
  },
});
