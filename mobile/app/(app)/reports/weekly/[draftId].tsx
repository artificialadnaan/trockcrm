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
  formatWeeklyReportDictation,
  getTranscriptionConfig,
  getWeeklyReport,
  getWeeklyReportAssignments,
  getWeeklyReportPhotoCandidates,
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReport,
} from "../../../../src/api/endpoints";
import type { WeeklyReportPhotoCandidate, WeeklyReportStatusValue } from "../../../../src/api/types";
import { qk } from "../../../../src/query/keys";
import { newClientUploadId, uploadOwnerKey } from "../../../../src/capture/upload-queue";
import { uploadCapture } from "../../../../src/capture/upload";
import { getLiveGps } from "../../../../src/capture/metadata";
import {
  weeklyReportDictationText,
  type WeeklyReportDictationPort,
} from "../../../../src/weekly-reports/dictation";
import { retryWeeklyReportPhotoUploads } from "../../../../src/weekly-reports/photo-import";
import { weeklyReportServerReportId } from "../../../../src/weekly-reports/hub";
import { isWeeklyReportWeekTakenError } from "../../../../src/weekly-reports/reconcile";
import { newSubmissionId } from "../../../../src/scorecards/ids";
import {
  adoptWeeklyReportWeekRow,
  resolveWeeklyReportDraftRow,
  runWeeklyReportSubmit,
} from "../../../../src/weekly-reports/submit";
import {
  MAX_WEEKLY_REPORT_CAPTION_CHARS,
  MAX_WEEKLY_REPORT_PHOTOS,
  MAX_WEEKLY_REPORT_SECTION_CHARS,
  WEEKLY_REPORT_STEPS,
  enqueueWeeklyReportAutosave,
  isImportedWeeklyReportPhoto,
  weeklyReportDraftBlocker,
  weeklyReportDraftPendingUploads,
  weeklyReportDraftReducer,
  weeklyReportDraftToPatch,
  weeklyReportPhotoPreviewUri,
  weeklyReportPickerCandidates,
  weeklyReportSeedStateFromDetail,
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
  importWeeklyReportPhotoBatch,
  weeklyReportImportNotice,
} from "../../../../src/weekly-reports/photo-import";
import {
  weeklyReportEditorBusyMessage,
  weeklyReportStepLabel,
  weeklyReportSubmitErrorMessage,
} from "../../../../src/weekly-reports/editor-state";
import {
  formatWeekOf,
  weeklyReportCandidateTruncationNote,
  weeklyReportFinalAction,
} from "../../../../src/weekly-reports/status";
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

  /**
   * The loaded draft, TAGGED with the identity it was read for.
   *
   * A bare value is not safe here. `setLoaded(null)` runs inside an effect, i.e. AFTER the render in
   * which `ownerKey` changed — so for one render the previous owner's draft would be handed to the
   * wizard alongside the NEW owner key, and the wizard's autosave would write that draft into the new
   * owner/office namespace before the effect could clear it. One person's report would appear under
   * another's identity, or in the wrong office.
   *
   * Tagging and comparing on render closes the window: a mismatched pair simply renders as loading.
   */
  const [loaded, setLoaded] = useState<
    { ownerKey: string; draftId: string; draft: WeeklyReportDraft | "missing" } | null
  >(null);

  useEffect(() => {
    if (!ownerKey || !draftId) return;
    setLoaded(null);
    // Guard against a slow read for a PREVIOUS draftId resolving last and seeding the wizard with the
    // wrong draft — ignore any resolution after this effect has been superseded.
    let cancelled = false;
    void loadWeeklyReportDraft(ownerKey, draftId)
      .then((draft) => {
        if (!cancelled) setLoaded({ ownerKey, draftId, draft: draft ?? "missing" });
      })
      .catch(() => {
        // A read failure must not strand the screen on "Loading…" — resolve to not-found so the user gets
        // a clear message and a way back.
        if (!cancelled) setLoaded({ ownerKey, draftId, draft: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [ownerKey, draftId]);

  // Anything read for a different identity is treated as not-yet-loaded, never rendered.
  const current = loaded && loaded.ownerKey === ownerKey && loaded.draftId === draftId ? loaded.draft : null;

  if (current === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Weekly report" />
        <LoadingState label="Loading…" />
      </SafeAreaView>
    );
  }
  if (current === "missing") {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Weekly report" />
        <EmptyState title="Draft not found" subtitle="It may have been submitted or discarded." />
      </SafeAreaView>
    );
  }

  // `key` remounts the reducer host when a different draft arrives, so no state leaks between drafts.
  return <Wizard key={`${ownerKey}|${draftId}`} initial={current} ownerKey={ownerKey!} draftId={draftId} />;
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
  // A passive autosave can retain the pre-renewal draft while the replacement submission id reaches disk.
  // Read this only from INSIDE the queued save so delayed autosaves retain newer prose but never put the
  // retired key (or its row-bound lifecycle state) back after the durable renewal.
  const renewedClientSubmissionId = useRef<string | null>(null);
  // `importing` is React state and does not update before a second rapid tap re-reads it, so a ref is what
  // actually bars the double-tap before the picker opens.
  const importInFlight = useRef(false);

  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });
  const voiceEnabled = transcribeConfig.data?.configured ?? false;

  /**
   * The server-side dictation pass, bound to this session.
   *
   * Memoised on `fetcher` so the three section recorders share one identity and a re-render mid-dictation
   * cannot hand a half-finished turn a different port. It carries the transcript and a character count and
   * nothing else — never the section's text, which is what makes "the server cannot overwrite what I
   * typed" a property of the request rather than a promise about the handler.
   */
  const dictationPort = useCallback<WeeklyReportDictationPort>(
    (body) => formatWeeklyReportDictation(fetcher, body),
    [fetcher],
  );

  useEffect(() => {
    if (finalized.current) return;
    saveChain.current = enqueueWeeklyReportAutosave(saveChain.current, draft, {
      finalized: () => finalized.current,
      // A renewal may be immediately ahead of this autosave in `saveChain`, even though this render
      // still holds its retired key. The helper reads this when the queued callback executes.
      renewedClientSubmissionId: () => renewedClientSubmissionId.current,
      save: (snapshot) => saveWeeklyReportDraft(ownerKey, snapshot, Date.now()),
    });
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
  /**
   * A dictation produced words and the section had no room for them.
   *
   * Passed down rather than reached for: the recorder lives in `SectionStep`, which has no notice state,
   * and the alternative was to keep dropping the outcome silently. That was the real failure — the super
   * watched "Transcribing…", then "Tidying up…", then nothing appeared, with no error and no reason to
   * look for one.
   */
  const notifySectionFull = useCallback(() => {
    setNotice({
      tone: "error",
      text: "That section is already full, so the dictation could not be added. Shorten it and try again.",
    });
  }, []);

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
   * Replace a key the server retired and make that replacement durable before another create can use it.
   *
   * This is deliberately a read-modify-write through `saveChain`, rather than an autosave of this render's
   * `draft`: the renewal clears the former row's identity and lifecycle state, while another queued write
   * may carry newer prose or photos. Reading after every earlier save has settled preserves both. More
   * importantly, the caller AWAITS this promise before its retry; a React dispatch alone vanishes with an
   * app kill.
   */
  const persistRenewedClientSubmissionId = useCallback(
    async (clientSubmissionId: string): Promise<void> => {
      const persisted = saveChain.current.then(async () => {
        if (finalized.current) throw new Error("This weekly report draft has already been finalized.");
        const stored = await loadWeeklyReportDraft(ownerKey, draftId);
        if (!stored) throw new Error("This weekly report draft is no longer available.");
        await saveWeeklyReportDraft(
          ownerKey,
          weeklyReportDraftReducer(stored, { type: "renewClientSubmissionId", clientSubmissionId }),
          Date.now(),
        );
        // Set before this queued write resolves. Any autosave already appended behind it must normalize
        // its stale render snapshot before touching disk, while a failed renewal leaves the old key alone.
        renewedClientSubmissionId.current = clientSubmissionId;
      });

      // Let a failed durable save stop THIS retry, but leave the serialization chain usable for a later
      // user retry. Swallowing it before the await would create a report under a key the next app launch
      // cannot know, which is the exact orphan this recovery is meant to prevent.
      saveChain.current = persisted.catch(() => undefined);
      await persisted;
      // Do not leave a volatile renewed key in React state when its disk write failed. If the user retries
      // after that error, the old key is retried and this same durable renewal path runs again.
      dispatch({ type: "renewClientSubmissionId", clientSubmissionId });
    },
    [ownerKey, draftId],
  );

  /**
   * The week already has a row, created under a DIFFERENT submission id — i.e. started on another device.
   *
   * Adopting it is the only way forward: without this the create 409s identically on every retry, the
   * wizard has no path to that row, and everything the super typed here dies with a Discard whose copy
   * never says so. The rule — and which of the three sentences the user gets — lives in submit.ts; this
   * only supplies the two reads and the dispatch.
   */
  const adoptExistingWeekRow = useCallback(
    (): Promise<string> =>
      adoptWeeklyReportWeekRow(
        { weekLabel: formatWeekOf(draft.weekOf) },
        {
          // The assignment payload already names the row for every week this hub can OPEN — the current
          // week's id, plus `outstandingWeekReportIds` for the missed ones. No new endpoint needed, and
          // "the hub does not name it" is exactly the case whose copy must not point at the hub.
          findServerReportId: async () => {
            const assignments = await getWeeklyReportAssignments(fetcher);
            const project = assignments.projects.find(
              (candidate) => candidate.weeklyReportProjectId === draft.weeklyReportProjectId,
            );
            return project ? weeklyReportServerReportId(project, draft.weekOf) : null;
          },
          read: async (reportId) => (await getWeeklyReport(fetcher, reportId)).report,
          adopt: (reportId, seededFrom) =>
            dispatch({ type: "setReportId", reportId, seededFrom }),
        },
      ),
    [draft.weekOf, draft.weeklyReportProjectId, fetcher],
  );

  /**
   * Make sure a server report exists, returning its id.
   *
   * Idempotent on `clientSubmissionId`, which was stamped once when the local draft was created — so a
   * create whose response was lost returns the SAME report on the next attempt instead of a duplicate for
   * the week. A report opened for review already has an id and never reaches the POST.
   */
  const ensureReport = useCallback(
    async (): Promise<{ reportId: string; replacesExistingReport: boolean }> => {
      let resolved;
      try {
        // A saved report id is only a hint, not proof: leadership may have deleted the row while this phone
        // was on Photos. The resolver acts only on the server's explicit author-recovery signal — a field
        // 404 may instead conceal a live report after reassignment, and author-mode UI is not authorship —
        // then durably resets the old row state and renews its submission key before creating a replacement.
        resolved = await resolveWeeklyReportDraftRow(
          { reportId: draft.reportId, clientSubmissionId: draft.clientSubmissionId },
          {
            read: (reportId) => getWeeklyReport(fetcher, reportId),
            create: (clientSubmissionId) =>
              createWeeklyReport(fetcher, {
                clientSubmissionId,
                weeklyReportProjectId: draft.weeklyReportProjectId,
                weekOf: draft.weekOf,
              }),
            newClientSubmissionId: newSubmissionId,
            // Awaited through the save chain BEFORE the retry leaves, so a create whose reply is lost on the
            // way back is still idempotent under this new key after an app death.
            onRenewed: persistRenewedClientSubmissionId,
          },
        );
      } catch (error) {
        if (!isWeeklyReportWeekTakenError(error)) throw error;
        return { reportId: await adoptExistingWeekRow(), replacesExistingReport: false };
      }
      if (resolved.kind === "existing") {
        return { reportId: resolved.reportId, replacesExistingReport: false };
      }
      if (resolved.kind === "replacement-week-taken") {
        return { reportId: await adoptExistingWeekRow(), replacesExistingReport: true };
      }
      const created = resolved.created;
      // Stamp what the server actually handed back rather than assuming an empty row: the create is
      // idempotent, so this can be a row that already exists, and the provenance every later freshness
      // check reads has to describe the row that is really there.
      dispatch({
        type: "setReportId",
        reportId: created.report.id,
        seededFrom: weeklyReportSeedStateFromDetail(created.report),
      });
      return { reportId: created.report.id, replacesExistingReport: resolved.replacesExistingReport };
    },
    [
      draft.reportId,
      draft.clientSubmissionId,
      draft.weeklyReportProjectId,
      draft.weekOf,
      fetcher,
      adoptExistingWeekRow,
      persistRenewedClientSubmissionId,
    ],
  );

  // The report row has to exist before the picker can ask what photos fall in its window, so create it
  // when the user reaches the photos step rather than at submit. Failure is left silent here: the step
  // renders its own "couldn't load" state, and an error banner on arrival would fire for anyone who
  // simply walked through the wizard while offline.
  const onPhotosStep = draft.step === "photos";
  useEffect(() => {
    if (!onPhotosStep) return;
    void ensureReport().catch(() => undefined);
  }, [onPhotosStep, ensureReport]);

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

  /**
   * Re-drive photos that are attached to the draft but never reached the server.
   *
   * Without this the submit blocker is permanent: nothing else re-tries a failed upload, so a super who
   * imported with no signal could not file the report at all once back in coverage — waiting did
   * nothing and re-importing just duplicated the rows.
   */
  const [retryingUploads, setRetryingUploads] = useState(false);
  async function retryUploads() {
    const pending = weeklyReportDraftPendingUploads(draft).filter(
      (photo) => photo.localUri && photo.clientUploadId,
    );
    if (pending.length === 0 || retryingUploads) return;
    setRetryingUploads(true);
    setNotice(null);
    try {
      const outcome = await retryWeeklyReportPhotoUploads(
        pending.map((photo) => ({
          clientUploadId: photo.clientUploadId!,
          localUri: photo.localUri!,
          width: photo.width,
          height: photo.height,
        })),
        {
          upload: async (input) => {
            const uploaded = await uploadCapture(fetcher, {
              uri: input.uri,
              width: input.width,
              height: input.height,
              target: { dealId: draft.dealId },
              category: null,
              caption: null,
              tags: ["weekly-report"],
              metadata: input.metadata,
              clientUploadId: input.clientUploadId,
            });
            return { fileId: uploaded.id, remoteUrl: uploaded.imageUrl };
          },
          resolveUpload: (key, fileId, remoteUrl) =>
            dispatch({ type: "resolvePhotoUpload", key, fileId, remoteUrl }),
        },
      );
      setNotice(
        outcome.failedToUpload > 0
          ? {
              tone: "error",
              text: `${outcome.failedToUpload} photo${outcome.failedToUpload === 1 ? " still could not" : "s still could not"} upload. Try again with a better signal, or remove ${outcome.failedToUpload === 1 ? "it" : "them"}.`,
            }
          : { tone: "success", text: "Photos uploaded." },
      );
    } catch (error) {
      setNotice({ tone: "error", text: weeklyReportSubmitErrorMessage(error) });
    } finally {
      setRetryingUploads(false);
    }
  }

  const stepIndex = weeklyReportStepIndex(draft.step);

  function goBack() {
    // Guarded on the SAME busy state as the footer and "Choose photos", and for the same reason.
    // On any step past the first this handler changes the step rather than removing the route, so
    // `usePreventRemove` never fires — the VoiceRecorder simply unmounts mid-recording and the audio
    // is gone before the user could stop it and ask for a transcript. Losing a dictated section to a
    // mistapped Back is exactly the failure this feature exists to spare people.
    if (anyVoiceBusy) {
      setNotice({ tone: "error", text: "Finish or cancel the recording first." });
      return;
    }
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
   *
   * The sequencing lives in `importWeeklyReportPhotoBatch`, which persists the WHOLE selection before it
   * awaits GPS or any upload. This function only supplies the effects and reports the outcome.
   */
  async function importPhotos() {
    if (importInFlight.current || submitting) return;
    importInFlight.current = true;
    setImporting(true);
    setNotice(null);
    try {
      const { reportId } = await ensureReport();
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

      const outcome = await importWeeklyReportPhotoBatch(assets, {
        newClientUploadId,
        // Durable-copy BEFORE anything else: a library uri expires, and the copy is what a resumed draft
        // renders (and what draft-store rebases after an iOS container rotation).
        copyIntoDraft: (clientUploadId, srcUri) =>
          copyPhotoIntoWeeklyDraft(ownerKey, draftId, clientUploadId, srcUri),
        addPhoto: (photo) => dispatch({ type: "addPhoto", photo }),
        // A location failure must not fail the import — the photo simply uploads without coordinates.
        getLiveGps: () => getLiveGps().catch(() => null),
        upload: async (input) => {
          const photo = await uploadCapture(fetcher, {
            uri: input.uri,
            width: input.width,
            height: input.height,
            target: { dealId: draft.dealId },
            category: null,
            caption: null,
            // Tagged so the gallery shows where an imported photo came from; the report's own caption is
            // a separate column and is never written to the file.
            tags: ["weekly-report"],
            metadata: input.metadata,
            clientUploadId: input.clientUploadId,
          });
          return { fileId: photo.id, remoteUrl: photo.imageUrl };
        },
        resolveUpload: (key, fileId, remoteUrl) =>
          dispatch({ type: "resolvePhotoUpload", key, fileId, remoteUrl }),
      });

      const failureNotice = weeklyReportImportNotice(outcome);
      if (failureNotice) {
        setNotice({ tone: "error", text: failureNotice });
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

  /**
   * Arm (or disarm) the "I fired this transition and never heard back" marker, DURABLY.
   *
   * It has to reach disk before the request leaves the phone, because the two attempts it connects are
   * normally separated by a dead connection or an app kill. Written through the same save chain as the
   * autosave so a slower earlier write cannot land on top of it.
   *
   * READ-MODIFY-WRITE of the one field, rather than persisting the render's `draft` with the marker
   * merged in. `ensureReport` has just dispatched the report id, and this closure was built before that —
   * writing the whole snapshot back would erase the draft's identity on disk until the next autosave put
   * it back. Touching one field can only ever lose the marker, never anything else.
   */
  async function markPendingTransition(to: WeeklyReportStatusValue | null) {
    dispatch({ type: "setPendingTransition", to });
    saveChain.current = saveChain.current
      .then(async () => {
        if (finalized.current) return;
        const stored = await loadWeeklyReportDraft(ownerKey, draftId);
        if (!stored) return;
        await saveWeeklyReportDraft(ownerKey, { ...stored, pendingTransitionTo: to }, Date.now());
      })
      .catch(() => undefined);
    await saveChain.current;
  }

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
      // The ordering, the re-stamping and the lost-reply guard all live in submit.ts. `transitionTo` is
      // null when the report is ALREADY in the state this button would ask for — a PM fixing a caption on
      // an approved report — because the ladder has no self-transition and asking anyway would 409 on work
      // that saved perfectly well.
      await runWeeklyReportSubmit(
        { draft, patch, transitionTo: finalAction.transitionTo },
        {
          ensureReport,
          updateContent: async (reportId, body) =>
            (await updateWeeklyReport(fetcher, reportId, body)).report,
          replacePhotos: async (reportId, photos) =>
            (await replaceWeeklyReportPhotos(fetcher, reportId, photos)).report,
          // Each acknowledged write moves the baseline the NEXT open reconciles against. Autosaved with
          // the rest of the draft by the effect above.
          recordSeed: (seededFrom) => dispatch({ type: "setSeededFrom", seededFrom }),
          markPendingTransition,
          transition: async (reportId, to) =>
            (await transitionWeeklyReport(fetcher, reportId, to)).report.status,
          readStatus: async (reportId) => (await getWeeklyReport(fetcher, reportId)).report.status,
          recordStatus: (status) => dispatch({ type: "setServerStatus", status }),
        },
      );

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
            // Merged, not raw: a selected photo the window does not carry would otherwise count toward
            // "N selected" with no tick on screen and no way to deselect it.
            candidates={weeklyReportPickerCandidates(candidates.data?.photos ?? [], draft.photos)}
            loading={candidates.isLoading}
            failed={candidates.isError}
            truncationNote={weeklyReportCandidateTruncationNote(
              candidates.data?.photos?.length ?? 0,
              candidates.data?.total,
            )}
            selectedFileIds={new Set(draft.photos.map((photo) => photo.fileId).filter(Boolean) as string[])}
            selectedCount={draft.photos.length}
            cellSize={cell}
            importing={importing}
            weekOf={draft.weekOf}
            onToggle={toggleCandidate}
            onImport={() => void importPhotos()}
            pendingUploadCount={weeklyReportDraftPendingUploads(draft).length}
            retrying={retryingUploads}
            onRetryUploads={() => void retryUploads()}
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
                onSectionFull={notifySectionFull}
                dictationPort={dictationPort}
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
                onSectionFull={notifySectionFull}
                dictationPort={dictationPort}
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
                onSectionFull={notifySectionFull}
                dictationPort={dictationPort}
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
  onSectionFull,
  dictationPort,
  dispatch,
}: {
  sectionKey: WeeklyReportSectionKey;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  voiceEnabled: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Raised when a dictation produced words but the section had no room for them. */
  onSectionFull: () => void;
  dictationPort: WeeklyReportDictationPort;
  dispatch: React.Dispatch<WeeklyReportDraftAction>;
}) {
  // The latest rendered section text, readable from inside an async handler that started renders ago.
  // A ref rather than state: nothing should re-render because a dictation is in flight, and the handler
  // needs the value at the moment it clamps, not the one it closed over.
  const valueRef = useRef(value);
  valueRef.current = value;

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
          onTranscript={async (text) => {
            // Cleaned into dash bullets on the way in, because that is how the report prints — server-side
            // when there is a signal, by the on-device split when there is not. Either way it is APPENDED,
            // never substituted for the box: whatever the superintendent typed by hand is untouched, and
            // the request never carries that text in the first place.
            //
            // AWAITED by the recorder, which is what keeps `voiceBusy` (and therefore the leave guard) in
            // force across the round trip rather than only across transcription.
            const outcome = await weeklyReportDictationText(
              // A GETTER, not `value.length`. The box stays editable for the seconds this takes, so a
              // render-time count is wrong in both directions by the time the answer lands: delete text
              // and the stale count is too large, so the clamp silently discards dictated words that
              // would have fit; type and it is too small, so the reducer drops the tail instead. Reading
              // the latest render's value at clamp time makes the room the real room.
              { transcript: text, existingChars: () => valueRef.current.length },
              dictationPort,
            );
            if (!outcome.text) {
              // A full section used to be indistinguishable from nothing-was-said, and both were dropped
              // here in silence. The super watched "Transcribing…" then "Tidying up…", saw nothing
              // appear, and had no way to know their words went nowhere or why.
              if (outcome.emptyReason === "full") onSectionFull();
              return;
            }
            dispatch({ type: "appendSection", key: sectionKey, text: outcome.text });
          }}
        />
      ) : null}
    </View>
  );
}

function PhotoPickerStep({
  candidates,
  loading,
  failed,
  truncationNote,
  selectedFileIds,
  selectedCount,
  cellSize,
  importing,
  weekOf,
  onToggle,
  onImport,
  pendingUploadCount,
  retrying,
  onRetryUploads,
}: {
  candidates: WeeklyReportPhotoCandidate[];
  loading: boolean;
  failed: boolean;
  /** Set when the window came back capped — see weeklyReportCandidateTruncationNote. */
  truncationNote: string | null;
  selectedFileIds: Set<string>;
  selectedCount: number;
  cellSize: number;
  importing: boolean;
  weekOf: string;
  onToggle: (candidate: WeeklyReportPhotoCandidate) => void;
  onImport: () => void;
  pendingUploadCount: number;
  retrying: boolean;
  onRetryUploads: () => void;
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
      {/* And say when the window was CAPPED. The list is newest-first, so what is missing is the start of
          the fortnight — for a late report, the days it is actually about. */}
      {truncationNote ? <Text style={styles.hint}>{truncationNote}</Text> : null}
      <Button title="Import from device" variant="ghost" onPress={onImport} loading={importing} />
      {pendingUploadCount > 0 && (
        <Button
          title={`Retry uploads (${pendingUploadCount})`}
          variant="ghost"
          onPress={onRetryUploads}
          loading={retrying}
        />
      )}
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
