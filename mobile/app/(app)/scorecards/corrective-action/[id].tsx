import React, { Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  submitCorrectiveActionItem,
  type CorrectiveResponsePhoto,
} from "../../../../src/scorecards/corrective-action";
import { formatShortDate } from "../../../../src/scorecards/detail-view";
import type { CorrectiveActionItem } from "../../../../src/api/types";
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

function isOpen(item: CorrectiveActionItem): boolean {
  return item.status === "open";
}

export default function CorrectiveActionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; token?: string }>();
  const id = toStr(params.id);
  const { fetcher, user, activeOfficeId } = useAuth();
  const qc = useQueryClient();

  const itemsQuery = useCorrectiveActions(id);
  // The scorecard detail carries the dealId (upload target) + project name for the header context. The
  // corrective-actions payload itself does not include the deal, so we read it here.
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
  const officeId = scorecard?.officeId ?? activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = uploadOwnerKey(user?.id, officeId ?? undefined);

  const errorStatus = (itemsQuery.error as { status?: number } | null | undefined)?.status;
  // The read endpoint 404s when the scorecard has no corrective actions (not below-band / unknown) — that's a
  // genuinely-absent flow, not a load error. Any OTHER failure is retryable.
  const isMissing = itemsQuery.isError && errorStatus === 404;
  const isLoadError = itemsQuery.isError && !isMissing;

  const openCount = items.filter(isOpen).length;
  const allResolved = items.length > 0 && openCount === 0;

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
                {allResolved
                  ? "All items resolved."
                  : `${openCount} of ${items.length} item${items.length === 1 ? "" : "s"} still open. Document the corrective action for each.`}
              </Text>
            </View>

            {allResolved ? (
              <Banner tone="success" message="Corrective action complete — every flagged item has a documented response." />
            ) : null}

            {items.map((item) => (
              <CorrectiveActionItemCard
                key={item.id}
                item={item}
                scorecardId={id}
                dealId={dealId}
                ownerKey={ownerKey}
                voiceEnabled={voiceEnabled}
                canRespond={Boolean(ownerKey) && Boolean(dealId)}
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
  // delete-out-from-under), and skip once submitted OK (already cleaned). A resolved item never reaches this
  // component branch (it early-returns ResolvedItemCard above), so there's nothing to clean there.
  const cleanupGuardRef = useRef({ submitting: false, submittedOk: false });
  cleanupGuardRef.current.submitting = submitting;
  useEffect(() => {
    return () => {
      const g = cleanupGuardRef.current;
      if (g.submitting || g.submittedOk) return;
      void deleteDraftPhotoDir(ownerKey, draftId);
    };
    // Owner+draftId are stable for this card; run the teardown once on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, draftId]);

  if (item.status !== "open") {
    return <ResolvedItemCard item={item} />;
  }

  const busy = savingPhotos > 0 || submitting || voiceBusy || captionVoiceBusy;
  const captionPhoto = state.photos.find((p) => p.key === captionKey) ?? null;

  async function onRemovePhoto(photo: CorrectiveResponsePhoto) {
    // Cancel any queued/in-flight upload for this photo FIRST (a prior offline submit enqueued it under this
    // clientUploadId). Awaiting removeQueuedUploadsAndWait guarantees a worker that already selected it can't
    // still confirm — otherwise a later drain would upload evidence the user just pulled off the response.
    // Only THEN delete the durable draft copy + drop it from state (same order for every removal path).
    await removeQueuedUploadsAndWait(ownerKey, [photo.clientUploadId]).catch(() => undefined);
    await deleteDraftPhotoFile(photo.uri);
    dispatch({ type: "removePhoto", key: photo.key });
  }

  async function onCameraCapture(shot: CapturedShot, caption: string) {
    if (state.photos.length >= MAX_RESPONSE_PHOTOS) {
      setNotice({ tone: "error", text: `A response can hold at most ${MAX_RESPONSE_PHOTOS} photos.` });
      return;
    }
    const clientUploadId = newClientUploadId();
    setSavingPhotos((n) => n + 1);
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
    try {
      const result = await submitCorrectiveActionItem(fetcher, ownerKey, {
        scorecardId,
        itemId: item.id,
        dealId,
        photos: state.photos,
        comment: state.comment.trim(),
      });
      if (result.status === "photos_pending") {
        setNotice({ tone: "error", text: `${result.remaining} photo${result.remaining === 1 ? "" : "s"} still uploading — they'll keep retrying. Try again shortly.` });
        setSubmitting(false);
        return;
      }
      if (result.status === "photos_failed") {
        setNotice({ tone: "error", text: `${result.failed} photo${result.failed === 1 ? "" : "s"} couldn't upload after several tries. Remove and re-add ${result.failed === 1 ? "it" : "them"}, then submit.` });
        setSubmitting(false);
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
    }
  }

  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <Badge label={item.itemType === "critical_deficiency" ? "Critical deficiency" : "Action item"} />
        <Badge label="Open" color={theme.color.surfaceMuted} />
      </View>
      <Text style={styles.itemLabel}>{item.itemLabel}</Text>

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
        <Text style={styles.metaSmall}>Preparing this project — pull to refresh if the response stays disabled.</Text>
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
        <Image source={{ uri: photo.uri }} style={styles.thumb} />
      </Pressable>
      <Pressable onPress={onRemove} hitSlop={8} style={styles.thumbRemove} accessibilityRole="button" accessibilityLabel="Remove photo">
        <Text style={styles.thumbRemoveText}>✕</Text>
      </Pressable>
    </View>
  );
}

function ResolvedItemCard({ item }: { item: CorrectiveActionItem }) {
  // The read endpoint resolves a presigned `url` per response photo — render them as tappable thumbnails so
  // the documented evidence is inspectable in TRock Cam (mirrors the scorecard detail evidence grid: tap →
  // open the presigned url in the system browser). Fall back to the count only for photos without a url (an
  // older API deployment, or a failed presign).
  const photosWithUrl = item.photos.filter((p) => Boolean(p.url));
  const withoutUrl = item.photos.length - photosWithUrl.length;
  return (
    <View style={[styles.itemCard, styles.itemCardResolved]}>
      <View style={styles.itemHeader}>
        <Badge label={item.itemType === "critical_deficiency" ? "Critical deficiency" : "Action item"} />
        <Badge label="Resolved" color="#DCFCE7" textColor="#166534" />
      </View>
      <Text style={styles.itemLabel}>{item.itemLabel}</Text>
      {item.responseComment ? <Text style={styles.resolvedComment}>{item.responseComment}</Text> : null}
      {photosWithUrl.length > 0 ? (
        <View style={styles.photoRow}>
          {photosWithUrl.map((photo) => (
            <Pressable
              key={photo.id}
              onPress={() => photo.url && void Linking.openURL(photo.url).catch(() => undefined)}
              accessibilityRole="imagebutton"
              accessibilityLabel={photo.caption ?? "Response photo"}
            >
              <Image source={{ uri: photo.url! }} style={styles.thumb} resizeMode="cover" />
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
