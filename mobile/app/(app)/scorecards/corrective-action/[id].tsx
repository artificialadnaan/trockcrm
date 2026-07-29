import React, { Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ExpoImage } from "expo-image";
import { theme } from "../../../../src/theme/theme";
import { useAuth } from "../../../../src/auth/AuthContext";
import { useCorrectiveActions, useScorecard } from "../../../../src/query/hooks";
import { getTranscriptionConfig } from "../../../../src/api/endpoints";
import { qk } from "../../../../src/query/keys";
import { uploadOwnerKey, newClientUploadId, removeQueuedUploadsAndWait } from "../../../../src/capture/upload-queue";
import { copyPhotoIntoDraft, deleteDraftPhotoDir, deleteDraftPhotoFile } from "../../../../src/scorecards/draft-store";
import { extractExifMetadata, getLiveGps } from "../../../../src/capture/metadata";
import type { CapturedShot } from "../../../../src/capture/CameraCapture";
import {
  correctiveResponseReducer,
  emptyCorrectiveResponse,
  shouldReclaimDraftDirOnCaptureSettle,
  shouldReclaimDraftDirOnSettle,
  submitCorrectiveActionItem,
  type CorrectiveResponsePhoto,
} from "../../../../src/scorecards/corrective-action";
import { formatShortDate } from "../../../../src/scorecards/detail-view";
import type { CorrectiveActionItem, CorrectiveActionResponsePhoto } from "../../../../src/api/types";
import { Badge, Button, EmptyState, LoadingState, SectionLabel, TextInput } from "../../../../src/components/ui";
import { Banner } from "../../../../src/components/Banner";
import { ScreenHeader } from "../../../../src/components/ScreenHeader";
import { PhotoCaptionEditor } from "../../../../src/components/PhotoCaptionEditor";
import { VoiceRecorder } from "../../../../src/components/VoiceRecorder";

const CameraCapture = React.lazy(() => import("../../../../src/capture/CameraCapture"));

const MAX_RESPONSE_PHOTOS = 20;

function toStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

/**
 * Is this item still the RESPONDER'S to answer?
 *
 * `open` and `rejected` both are. After migration 0202 an approver can send work back, and gating on
 * `open` alone left a rejected item read-only on the phone — the responder could see the approver asked for
 * a fix and had no way to give one.
 */
function isOpen(item: CorrectiveActionItem): boolean {
  return item.status === "open" || item.status === "rejected";
}

export default function CorrectiveActionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; token?: string }>();
  const id = toStr(params.id);
  const { fetcher, user, activeOfficeId } = useAuth();
  const qc = useQueryClient();

  const itemsQuery = useCorrectiveActions(id);
  // The scorecard detail carries the project name (header context) + officeId, and the dealId used ONLY to
  // invalidate the project's scorecards cache after a resolve. It is NOT required to submit — the response
  // endpoints resolve the deal from the scorecard id server-side — so a slow/failed detail query never
  // blocks Submit (see canRespond below).
  const scorecardQuery = useScorecard(id);

  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });
  const voiceEnabled = transcribeConfig.data?.configured ?? false;

  // Refresh expiring context + statuses on focus (mirrors the other scorecard screens — RN has no
  // refetchOnWindowFocus wiring).
  useFocusEffect(
    useCallback(() => {
      void itemsQuery.refetch();
      void scorecardQuery.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]),
  );

  const items = itemsQuery.data?.items ?? [];
  const scorecard = scorecardQuery.data?.scorecard;
  const dealId = scorecard?.dealId ?? "";
  // The draft ownerKey is ONLY a local on-disk namespace for the per-item copy dir (sanitizeOwnerKey builds
  // the path). It must be STABLE for the screen's lifetime: a photo captured before the secondary
  // scorecard-detail query resolves is copied under this key, and if the key later changed (an off-office
  // card's real officeId arriving) the unmount-cleanup would delete that dir while the uri is still in reducer
  // state → submit fails. So derive it from SESSION-STABLE values (user + active office / tenant) and
  // deliberately NOT from scorecard.officeId — the corrective-action uploads are SCORECARD-scoped server-side
  // (the server resolves the deal/office from the scorecard id), so the embedded office needn't match the
  // card's real office. Lock in the first non-empty value via a ref so it never flips mid-session.
  const ownerKeyRef = useRef<string>("");
  const derivedOwnerKey = uploadOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? undefined);
  if (!ownerKeyRef.current && derivedOwnerKey) ownerKeyRef.current = derivedOwnerKey;
  const ownerKey = ownerKeyRef.current || derivedOwnerKey;

  const errorStatus = (itemsQuery.error as { status?: number } | null | undefined)?.status;
  // The read endpoint 404s when the scorecard has no corrective actions (not below-band / unknown) — that's a
  // genuinely-absent flow, not a load error. Any OTHER failure is retryable.
  const isMissing = itemsQuery.isError && errorStatus === 404;
  const isLoadError = itemsQuery.isError && !isMissing;

  const openCount = items.filter(isOpen).length;
  // NOTHING LEFT FOR THE RESPONDER is not the same as APPROVED. With the last item submitted the card sits
  // at corrective_action_submitted and an approver can still send it back; announcing "complete" there is a
  // promise this screen cannot keep.
  const nothingOutstanding = items.length > 0 && openCount === 0;
  const allApproved = nothingOutstanding && items.every((i) => i.status === "approved");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader onBack={() => router.back()} title="Corrective action" />
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={itemsQuery.isRefetching}
            onRefresh={() => void itemsQuery.refetch()}
            tintColor={theme.color.brandRed}
          />
        }
      >
        {itemsQuery.isLoading ? (
          <LoadingState label="Loading corrective actions…" />
        ) : isMissing ? (
          <EmptyState
            title="No corrective actions"
            subtitle="This scorecard has no corrective-action items — it may not be below standard, or it was removed."
          />
        ) : isLoadError ? (
          <Banner
            tone="error"
            message="Couldn't load the corrective actions."
            action={{ label: "Retry", onPress: () => void itemsQuery.refetch() }}
          />
        ) : (
          <>
            <View style={{ gap: theme.space.xs }}>
              <Text style={styles.projectName} numberOfLines={2}>
                {scorecard?.projectName ?? scorecard?.projectNumber ?? "Project"}
              </Text>
              <Text style={styles.meta}>
                {allApproved
                  ? "All items approved."
                  : nothingOutstanding
                    ? "Submitted — awaiting approval."
                    : `${openCount} of ${items.length} item${items.length === 1 ? "" : "s"} still open. Document the corrective action for each.`}
              </Text>
            </View>

            {allApproved ? (
              <Banner tone="success" message="Corrective action approved — every flagged item was accepted." />
            ) : nothingOutstanding ? (
              <Banner
                tone="info"
                message="Your responses are with the approver. If anything needs more work you'll get another notification with the reason."
              />
            ) : null}

            {items.map((item) => (
              <CorrectiveActionItemCard
                key={item.id}
                item={item}
                scorecardId={id}
                dealId={dealId}
                ownerKey={ownerKey}
                voiceEnabled={voiceEnabled}
                // Gate responses ONLY on the upload owner identity (user + active office / tenant). ownerKey
                // derives from SESSION-STABLE values — never from dealId or the scorecard's officeId — so it's
                // ready even if the secondary scorecard-detail query is slow or failed. The corrective-action
                // endpoints resolve the deal from the scorecard id server-side, so dealId is not needed to
                // submit; gating on it would permanently disable Submit whenever that detail query lagged.
                canRespond={Boolean(ownerKey)}
                onResolved={() => {
                  if (user) {
                    void qc.invalidateQueries({ queryKey: qk.correctiveActions(user.id, id) });
                    void qc.invalidateQueries({ queryKey: qk.scorecard(user.id, id) });
                    if (dealId) void qc.invalidateQueries({ queryKey: qk.projectScorecards(user.id, dealId) });
                  }
                  void itemsQuery.refetch();
                }}
              />
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function CorrectiveActionItemCard({
  item,
  scorecardId,
  dealId,
  ownerKey,
  voiceEnabled,
  canRespond,
  onResolved,
}: {
  item: CorrectiveActionItem;
  scorecardId: string;
  dealId: string;
  ownerKey: string;
  voiceEnabled: boolean;
  canRespond: boolean;
  onResolved: () => void;
}) {
  const { fetcher } = useAuth();
  const [state, dispatch] = useReducer(correctiveResponseReducer, undefined, emptyCorrectiveResponse);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [savingPhotos, setSavingPhotos] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [captionKey, setCaptionKey] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [captionVoiceBusy, setCaptionVoiceBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  // Synthetic, per-item durable copy target so captured shots survive until submit (there's no persisted
  // draft here). Deterministic per scorecard+item so a re-entry reuses the same directory.
  const draftId = useRef(`corrective-${scorecardId}-${item.id}`).current;
  // Route-exit cleanup: captured shots are copied into the synthetic per-item dir, but nothing restores them
  // on re-entry — so backing out / an app kill before submit orphans the copies. On unmount of an UNRESOLVED
  // item, reclaim the dir. Guards (read from a ref so the unmount closure sees the LATEST values, not the
  // mount-time snapshot): skip while a submit is in flight (its own success path cleans up + would race a
  // delete-out-from-under), skip while a photo capture is in flight (it would re-create the dir + copy after
  // the delete — the last capture's settle path reclaims instead), and skip once submitted OK (already
  // cleaned). A resolved item never reaches this component branch (it early-returns ResolvedItemCard above),
  // so there's nothing to clean there.
  // Also carry ownerKey/draftId in the ref so the empty-dep cleanup below reads the CURRENT values (not a
  // stale mount-time snapshot) and never re-fires on a prop change. ownerKey is stable this session (parent
  // locks it to session-stable values), but reading it from the ref keeps the teardown correct regardless.
  // `mounted` lets the in-flight submit's OWN settle path reclaim the dir when the user backed out / the app
  // was killed mid-submit and the submit then FAILED (unmount-cleanup skipped it because submitting was true).
  // `inFlightCaptures` does the SAME for photo capture: onCameraCapture awaits GPS + copyPhotoIntoDraft (which
  // ensureDirs + copies a full-size file) while submitting=false, so the unmount-cleanup deletes the dir and
  // the still-running capture then re-creates it + copies AFTER unmount. Track the in-flight captures so the
  // LAST one to settle after an unmount reclaims that re-created dir (a synchronous ref, not lagging React
  // state — the unmount closure + the capture's finally both read the CURRENT count).
  const cleanupGuardRef = useRef({
    submitting: false,
    submittedOk: false,
    mounted: true,
    inFlightCaptures: 0,
    ownerKey,
    draftId,
  });
  cleanupGuardRef.current.submitting = submitting;
  cleanupGuardRef.current.ownerKey = ownerKey;
  cleanupGuardRef.current.draftId = draftId;
  useEffect(() => {
    // Truly unmount-only (empty deps): the cleanup must NOT run when ownerKey/draftId change mid-session — a
    // flip there (e.g. an off-office scorecard's real officeId arriving) would delete the dir out from under
    // photos still referenced in reducer state. Empty deps + a ref read guarantees it fires solely on unmount.
    return () => {
      const g = cleanupGuardRef.current;
      // Mark unmounted FIRST so an in-flight submit OR photo capture that settles after this can detect the
      // screen is gone and reclaim the dir itself. This teardown skips the delete while a submit is in flight
      // (avoid racing the success path) AND while a capture is in flight (copyPhotoIntoDraft would just
      // re-create the dir + copy a full-size file after we deleted it — the LAST capture's settle path
      // reclaims the re-created dir instead).
      g.mounted = false;
      if (g.submitting || g.submittedOk || g.inFlightCaptures > 0) return;
      void deleteDraftPhotoDir(g.ownerKey, g.draftId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A REWORK cycle starts a fresh draft, so NOTHING from the previous cycle may carry into it.
  //
  // This component instance survives every status transition — the resolved view is an early return from this
  // same component under a stable `key`, so the hooks below never unmount. A successful submit deliberately
  // leaves `submitting` true (the screen is going away, and clearing it would flash an enabled form), sets
  // submittedOk, and keeps the reducer's comment and photos. When the approver then rejects, the form comes
  // BACK on that instance: every control renders disabled off the stale `submitting`, `onSubmit` returns at
  // its own `if (submitting) return` guard, and the previous attempt's comment and photo list are sitting in
  // the form. The responder cannot file the rework at all without backing out and reopening the screen —
  // which is precisely the round trip the in-app rejection notice exists to save them.
  //
  // Resetting only submittedOk (which is all this did) fixed the photo-dir leak and left the form dead.
  //
  // Keyed on the BOOLEAN, not on `item.status` and not on `item`.
  //
  // `[item]` — which is what an exhaustive-deps autofix would produce, since the body reads it — re-fires on
  // every refetch identity change and would wipe a response mid-typing. `[item.status]` is nearly right but
  // still fires on any status change within the outstanding set. The boolean fires exactly when the item
  // BECOMES the responder's again, which is the whole intent, and it leaves the body reading nothing the
  // deps array does not name — so there is no lint to suppress and nothing for a future autofix to "correct".
  const outstanding = isOpen(item);
  useEffect(() => {
    if (!outstanding) return;
    cleanupGuardRef.current.submittedOk = false;
    setSubmitting(false);
    dispatch({ type: "reset" });
    setNotice(null);
  }, [outstanding]);

  // Use the SAME predicate the parent counts with. This gate was independently hard-coded to `open`, so a
  // rejected item counted as outstanding at the top of the screen while the card itself rendered read-only —
  // the responder was told they had work to do and given no controls to do it with.
  if (!outstanding) {
    return <ResolvedItemCard item={item} />;
  }

  // WHY it came back, on the form where the rework happens. The web responder shows this; without it here an
  // in-app responder following a rejection notification sees a blank form and has to go find the email.
  const latestRejection =
    item.status === "rejected"
      ? [...(item.events ?? [])].reverse().find((e) => e.eventType === "rejected") ?? null
      : null;

  const busy = savingPhotos > 0 || submitting || voiceBusy || captionVoiceBusy;
  const captionPhoto = state.photos.find((p) => p.key === captionKey) ?? null;

  async function onRemovePhoto(photo: CorrectiveResponsePhoto) {
    // Drop it from submission state FIRST (synchronously) so a Submit tapped right after Remove can NEVER
    // snapshot this photo — onSubmit reads state.photos, and the async cleanup below yields the event loop.
    // Only then do the best-effort durable cleanup: cancel any queued/in-flight upload for this photo (a
    // prior offline submit could have enqueued it under this clientUploadId) so a later drain can't confirm
    // evidence the user just pulled off, then delete the durable draft copy. Both are best-effort — the photo
    // is already gone from state, and orphaned queue/file cruft is reclaimed by the per-item dir teardown.
    dispatch({ type: "removePhoto", key: photo.key });
    await removeQueuedUploadsAndWait(ownerKey, [photo.clientUploadId]).catch(() => undefined);
    await deleteDraftPhotoFile(photo.uri).catch(() => undefined);
  }

  async function onCameraCapture(shot: CapturedShot, caption: string) {
    if (state.photos.length >= MAX_RESPONSE_PHOTOS) {
      setNotice({ tone: "error", text: `A response can hold at most ${MAX_RESPONSE_PHOTOS} photos.` });
      return;
    }
    const clientUploadId = newClientUploadId();
    setSavingPhotos((n) => n + 1);
    // Count this capture as in flight on the guard ref (synchronous, not lagging React state) so if the screen
    // unmounts mid-capture the settle path below can tell whether it's the LAST capture still copying into the
    // dir before reclaiming. copyPhotoIntoDraft ensureDirs + copies the full-size file, so a capture that
    // finishes after unmount re-creates the dir the unmount-cleanup already deleted.
    cleanupGuardRef.current.inFlightCaptures += 1;
    try {
      const exif = extractExifMetadata(shot.exif);
      let latitude = exif.latitude;
      let longitude = exif.longitude;
      let addressSource = exif.addressSource;
      if (latitude === undefined || longitude === undefined) {
        const live = await getLiveGps().catch(() => null);
        if (live?.latitude !== undefined && live?.longitude !== undefined) {
          latitude = live.latitude;
          longitude = live.longitude;
          addressSource = live.addressSource ?? addressSource;
        }
      }
      // Durable-copy before dispatch so the draft never holds a raw camera-cache uri that goes stale.
      const durableUri = await copyPhotoIntoDraft(ownerKey, draftId, clientUploadId, shot.uri);
      dispatch({
        type: "addPhoto",
        photo: {
          key: clientUploadId,
          uri: durableUri,
          clientUploadId,
          caption,
          takenAt: exif.takenAt ?? shot.capturedAt,
          latitude,
          longitude,
          addressSource,
          width: shot.width,
          height: shot.height,
        },
      });
    } catch {
      setNotice({ tone: "error", text: "Couldn't save that photo — please retake it." });
    } finally {
      setSavingPhotos((n) => n - 1);
      // Decrement FIRST so the reclaim check sees the true remaining count. If the screen has since unmounted
      // (the user backed out / the app was killed mid-capture) and the submit didn't succeed, the unmount
      // cleanup already deleted the dir with submitting=false — but this capture re-created it via
      // copyPhotoIntoDraft and (on the try path) copied a full-size file into it. Reclaim that re-created dir,
      // but only once this is the LAST in-flight capture so we never delete out from under a sibling still copying.
      const g = cleanupGuardRef.current;
      g.inFlightCaptures -= 1;
      if (
        shouldReclaimDraftDirOnCaptureSettle({
          mounted: g.mounted,
          submittedOk: g.submittedOk,
          inFlightCaptures: g.inFlightCaptures,
        })
      ) {
        void deleteDraftPhotoDir(g.ownerKey, g.draftId);
      }
    }
  }

  async function onSubmit() {
    if (submitting) return;
    if (savingPhotos > 0) {
      setNotice({ tone: "error", text: "Saving a photo — try again in a moment." });
      return;
    }
    if (voiceBusy || captionVoiceBusy) {
      setNotice({ tone: "error", text: "Finishing dictation — try again in a moment." });
      return;
    }
    if (!state.comment.trim()) {
      setNotice({ tone: "error", text: "A response comment is required." });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    // Any NON-success settle path (pending/failed/already-resolved/thrown) must reclaim the synthetic per-item
    // copy dir IF the screen has since unmounted — the user backed out (or the app was killed) while this
    // request was in flight, so the unmount-cleanup effect skipped the delete (submitting was true) and its
    // state setters below are no-ops. Without this the full-size durable copies leak in document storage
    // indefinitely. While still mounted the setters + (for already_submitted) the resolved-card unmount handle
    // cleanup; on genuine success the dir is already deleted (submittedOk) so this never double-deletes.
    const reclaimIfAbandoned = () => {
      const g = cleanupGuardRef.current;
      if (shouldReclaimDraftDirOnSettle({ mounted: g.mounted, submittedOk: g.submittedOk })) {
        void deleteDraftPhotoDir(g.ownerKey, g.draftId);
      }
    };
    try {
      const result = await submitCorrectiveActionItem(fetcher, {
        scorecardId,
        itemId: item.id,
        dealId,
        photos: state.photos,
        comment: state.comment.trim(),
      });
      if (result.status === "photos_pending") {
        setNotice({ tone: "error", text: `${result.remaining} photo${result.remaining === 1 ? "" : "s"} still uploading — they'll keep retrying. Try again shortly.` });
        setSubmitting(false);
        reclaimIfAbandoned();
        return;
      }
      if (result.status === "photos_failed") {
        setNotice({ tone: "error", text: `${result.failed} photo${result.failed === 1 ? "" : "s"} couldn't upload after several tries. Remove and re-add ${result.failed === 1 ? "it" : "them"}, then submit.` });
        setSubmitting(false);
        reclaimIfAbandoned();
        return;
      }
      if (result.status === "already_submitted") {
        // A concurrent responder resolved this item first — our uploads were discarded and did NOT attach.
        // Do NOT claim this as the user's submission: refresh so the parent swaps in the read-only resolved
        // card (whose unmount reclaims the synthetic draft dir), inform the user, and leave submittedOk unset.
        // If the screen already unmounted mid-submit, that resolved-card swap never happens, so reclaim here.
        setNotice({ tone: "error", text: "This item was just resolved by someone else. Showing their response — your comment and photos were not submitted." });
        setSubmitting(false);
        reclaimIfAbandoned();
        onResolved();
        return;
      }
      // Resolved — reclaim the synthetic per-item copy dir (best-effort; the photos are now durable server
      // records), then let the parent refetch/invalidate swap in the read-only resolved view. Mark submittedOk
      // so the unmount teardown doesn't fire a second (racing) delete of the same dir.
      cleanupGuardRef.current.submittedOk = true;
      void deleteDraftPhotoDir(ownerKey, draftId);
      onResolved();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Couldn't submit this response. Please try again.",
      });
      setSubmitting(false);
      // Thrown mid-flight after an unmount → this is the leak the P2 finding calls out (a failed in-flight
      // submit the unmount-cleanup deliberately skipped). Reclaim the abandoned dir.
      reclaimIfAbandoned();
    }
  }

  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <Badge label={item.itemType === "critical_deficiency" ? "Critical deficiency" : "Action item"} />
        {/* Derived, not hard-coded: isOpen now admits `rejected`, so this branch renders items the approver
            SENT BACK. Labelling those "Open" tells the responder nobody has looked at their work. */}
        <Badge
          label={item.status === "rejected" ? "Changes requested" : "Open"}
          color={item.status === "rejected" ? "#FEE2E2" : theme.color.surfaceMuted}
          textColor={item.status === "rejected" ? "#B91C1C" : undefined}
        />
      </View>
      <Text style={styles.itemLabel}>{item.itemLabel}</Text>
      {latestRejection ? (
        <View style={styles.rejectionNote}>
          <Text style={styles.rejectionNoteTitle}>
            {latestRejection.actorName ? `Sent back by ${latestRejection.actorName}` : "Sent back"}
          </Text>
          <Text style={styles.rejectionNoteBody}>{latestRejection.comment}</Text>
        </View>
      ) : null}

      {notice ? <Banner message={notice.text} tone={notice.tone} /> : null}

      <SectionLabel>What was done</SectionLabel>
      <TextInput
        value={state.comment}
        onChangeText={(text) => dispatch({ type: "setComment", comment: text })}
        placeholder="Describe the corrective action taken"
        multiline
        style={styles.commentInput}
      />
      {voiceEnabled ? (
        <VoiceRecorder
          onTranscript={(text) =>
            dispatch({ type: "setComment", comment: state.comment.trim() ? `${state.comment.trim()} ${text}` : text })
          }
          onBusyChange={setVoiceBusy}
        />
      ) : null}

      {state.photos.length > 0 ? (
        <View style={styles.photoRow}>
          {state.photos.map((photo) => (
            <ResponsePhotoThumb
              key={photo.key}
              photo={photo}
              onEdit={() => setCaptionKey(photo.key)}
              onRemove={() => void onRemovePhoto(photo)}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          title={savingPhotos > 0 ? "Saving photo…" : "Add photo"}
          variant="ghost"
          onPress={() => setCameraOpen(true)}
          disabled={savingPhotos > 0 || state.photos.length >= MAX_RESPONSE_PHOTOS}
          style={{ flex: 1 }}
        />
        <Button
          title={savingPhotos > 0 ? "Saving photo…" : voiceBusy || captionVoiceBusy ? "Finishing dictation…" : "Submit response"}
          onPress={() => void onSubmit()}
          loading={submitting}
          disabled={busy || !canRespond || !state.comment.trim()}
          style={{ flex: 1 }}
        />
      </View>
      {!canRespond ? (
        <Text style={styles.metaSmall}>Preparing your session — pull to refresh if the response stays disabled.</Text>
      ) : null}

      {cameraOpen ? (
        <Suspense fallback={null}>
          <CameraCapture
            onCapture={(shot, caption) => void onCameraCapture(shot, caption)}
            onClose={() => setCameraOpen(false)}
            count={state.photos.length}
            recent={state.photos.slice(-5).map((p) => p.uri)}
            annotatePerShot
            voiceEnabled={voiceEnabled}
          />
        </Suspense>
      ) : null}

      <Modal visible={captionPhoto !== null} transparent animationType="slide" onRequestClose={() => !captionVoiceBusy && setCaptionKey(null)}>
        <KeyboardAvoidingView style={styles.captionModalRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.captionBackdrop} onPress={() => !captionVoiceBusy && setCaptionKey(null)} accessibilityLabel="Close photo description" />
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
                footer={<Button title="Done" onPress={() => setCaptionKey(null)} disabled={captionVoiceBusy} />}
              />
            </SafeAreaView>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function ResponsePhotoThumb({
  photo,
  onEdit,
  onRemove,
}: {
  photo: CorrectiveResponsePhoto;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.thumbWrap}>
      <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel="Edit photo description">
        <ExpoImage
          source={{ uri: photo.uri }}
          style={styles.thumb}
          contentFit="cover"
          recyclingKey={photo.key}
          cachePolicy="memory-disk"
        />
      </Pressable>
      <Pressable onPress={onRemove} hitSlop={8} style={styles.thumbRemove} accessibilityRole="button" accessibilityLabel="Remove photo">
        <Text style={styles.thumbRemoveText}>✕</Text>
      </Pressable>
    </View>
  );
}

/**
 * The read-only card for an item that is no longer the responder's to answer.
 *
 * Its badge is derived, not hard-coded: `submitted` and `approved` both land here, and labelling both
 * "Resolved" in terminal-success green told the responder their work was accepted while it was still sitting
 * with an approver who could send it back — directly contradicting the awaiting-approval banner above it.
 */
function settledPresentation(status: string): { label: string; color: string; textColor: string } {
  return status === "approved"
    ? { label: "Approved", color: "#DCFCE7", textColor: "#166534" }
    : { label: "Awaiting approval", color: "#FEF3C7", textColor: "#92400E" };
}

function ResolvedItemCard({ item }: { item: CorrectiveActionItem }) {
  // The read endpoint resolves a presigned `url` per response photo — render them as tappable thumbnails so
  // the documented evidence is inspectable in TRock Cam (mirrors the scorecard detail evidence grid: tap →
  // open the presigned url in the system browser). Fall back to the count only for photos without a url (an
  // older API deployment, or a failed presign).
  // The aggregate is the NO-THREAD fallback only. With a thread present each attempt renders its own photos
  // above; also showing the merged set would repeat them and reattach the rejected round's evidence to the
  // replacement response — the exact confusion the per-attempt split exists to remove.
  const hasThread = (item.events?.length ?? 0) > 0;
  const photosWithUrl = hasThread ? [] : item.photos.filter((p) => Boolean(p.url));
  const withoutUrl = hasThread ? 0 : item.photos.length - photosWithUrl.length;
  return (
    <View style={[styles.itemCard, styles.itemCardResolved]}>
      <View style={styles.itemHeader}>
        <Badge label={item.itemType === "critical_deficiency" ? "Critical deficiency" : "Action item"} />
        <Badge {...settledPresentation(item.status)} />
      </View>
      <Text style={styles.itemLabel}>{item.itemLabel}</Text>
      {/* The THREAD, per attempt. Pairing the latest responseComment with item.photos — the aggregate of
          every photo ever linked — showed the rejected attempt's evidence as the newest response and hid the
          rejection and approval entirely. The API returns per-attempt sets; the aggregate is the fallback for
          a card with no thread. */}
      {(item.events?.length ?? 0) > 0 ? (
        item.events!.map((event) => (
          <View key={event.id} style={styles.attemptBlock}>
            <Text style={styles.attemptHeading}>
              {event.eventType === "approved"
                ? "Approved"
                : event.eventType === "rejected"
                  ? "Sent back"
                  : "Submitted"}
              {event.actorName ? ` · ${event.actorName}` : ""}
            </Text>
            {event.comment ? <Text style={styles.resolvedComment}>{event.comment}</Text> : null}
            {/* This attempt's OWN evidence. The aggregate gallery below is the no-thread fallback; showing
                both would put the rejected round's photos under the replacement response.

                The url-less COUNT has to move here with the thumbnails. Moving the photos per-attempt while
                leaving the count on the aggregate (which a threaded card forces to zero) made a failed
                presign render as no evidence at all — silently, which is the one thing the count exists to
                prevent: the responder cannot tell "nothing was attached" from "the link did not come back". */}
            <AttemptPhotos photos={event.photos} />
          </View>
        ))
      ) : item.responseComment ? (
        <Text style={styles.resolvedComment}>{item.responseComment}</Text>
      ) : null}
      {photosWithUrl.length > 0 ? (
        <View style={styles.photoRow}>
          {photosWithUrl.map((photo) => (
            <Pressable
              key={photo.id}
              onPress={() => photo.url && void Linking.openURL(photo.url).catch(() => undefined)}
              accessibilityRole="imagebutton"
              accessibilityLabel={photo.caption ?? "Response photo"}
            >
              <ExpoImage
                source={{ uri: photo.url! }}
                style={styles.thumb}
                contentFit="cover"
                recyclingKey={photo.id}
                cachePolicy="memory-disk"
              />
            </Pressable>
          ))}
        </View>
      ) : null}
      {withoutUrl > 0 ? (
        <Text style={styles.metaSmall}>
          {withoutUrl} response photo{withoutUrl === 1 ? "" : "s"} attached
        </Text>
      ) : null}
      <Text style={styles.metaSmall}>
        {item.responderName ? `Documented by ${item.responderName}` : "Documented"}
        {item.respondedAt ? ` · ${formatShortDate(item.respondedAt)}` : ""}
      </Text>
    </View>
  );
}

/** One attempt's evidence: the thumbnails that presigned, plus a count for any that did not. */
function AttemptPhotos({ photos }: { photos: CorrectiveActionResponsePhoto[] }) {
  const withUrl = photos.filter((p) => Boolean(p.url));
  const withoutUrl = photos.length - withUrl.length;
  return (
    <>
      {withUrl.length > 0 ? (
        <View style={styles.photoRow}>
          {withUrl.map((photo) => (
            <Pressable
              key={photo.id}
              onPress={() => photo.url && void Linking.openURL(photo.url).catch(() => undefined)}
              accessibilityRole="imagebutton"
              accessibilityLabel={photo.caption ?? "Response photo"}
            >
              <ExpoImage source={{ uri: photo.url! }} style={styles.thumb} contentFit="cover" />
            </Pressable>
          ))}
        </View>
      ) : null}
      {withoutUrl > 0 ? (
        <Text style={styles.metaSmall}>
          {withoutUrl} response photo{withoutUrl === 1 ? "" : "s"} attached
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, paddingBottom: theme.space.xxl },
  projectName: { fontFamily: theme.font.semibold, fontSize: 18, color: theme.color.textPrimary },
  meta: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  metaSmall: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  itemCard: {
    gap: theme.space.sm,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  itemCardResolved: { opacity: 0.92 },
  itemHeader: { flexDirection: "row", gap: theme.space.sm, alignItems: "center" },
  attemptBlock: { marginTop: theme.space.xs, gap: 2 },
  attemptHeading: { fontSize: 12, fontWeight: "700", color: theme.color.textMuted },
  rejectionNote: {
    marginTop: theme.space.xs,
    padding: theme.space.sm,
    borderRadius: 8,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    gap: 4,
  },
  rejectionNoteTitle: { fontSize: 11, fontWeight: "700", color: "#B91C1C", textTransform: "uppercase" },
  rejectionNoteBody: { fontSize: 14, color: "#7F1D1D" },
  itemLabel: { fontFamily: theme.font.medium, fontSize: 15, color: theme.color.textPrimary },
  commentInput: { minHeight: 96, textAlignVertical: "top" },
  resolvedComment: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary },
  photoRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  thumbWrap: { position: "relative" },
  thumb: { width: 72, height: 72, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  thumbRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.color.brandRed,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbRemoveText: { color: "#ffffff", fontSize: 12, fontFamily: theme.font.semibold },
  actions: { flexDirection: "row", gap: theme.space.md, marginTop: theme.space.xs },
  captionModalRoot: { flex: 1, justifyContent: "flex-end" },
  captionBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.4)" },
  captionSheet: {
    backgroundColor: theme.color.surfaceApp,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space.lg,
  },
});
