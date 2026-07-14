import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { discardScorecardEditEvidence, getRecentScorecards, getDealTeam } from "../../../src/api/endpoints";
import {
  createScorecardDraft,
  createLeadershipScorecardDraft,
  resolveScorecardTeamNames,
  seedScorecardDraftTeam,
  scorecardDraftSectionsAnswered,
  scorecardDraftNewPhotos,
  scorecardDraftEvidenceCleanupIds,
  isEditingScorecardDraft,
  type ScorecardDraft,
} from "../../../src/scorecards/draft";
import {
  listScorecardDraftsForUser,
  saveScorecardDraft,
  deleteScorecardDraft,
  type LocatedScorecardDraft,
} from "../../../src/scorecards/draft-store";
import { newClientUploadId, removeQueuedUploadsAndWait, uploadOwnerKey } from "../../../src/capture/upload-queue";
import { registerUploadBackgroundTask } from "../../../src/capture/upload-background-task";
import { newSubmissionId } from "../../../src/scorecards/ids";
import { FIELD_SCORECARD_SECTIONS, FIELD_SCORECARD_LEADERSHIP_SECTIONS } from "../../../src/scorecards/scoring";
import { Button, EmptyState, LoadingState, SectionLabel } from "../../../src/components/ui";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { SubmittedScorecardRow } from "../../../src/components/SubmittedScorecardRow";
import { TargetPicker } from "../../../src/components/TargetPicker";
import type { DealTeamResponse, FieldCaptureTarget } from "../../../src/api/types";

const SECTION_COUNT = FIELD_SCORECARD_SECTIONS.length;
const LEADERSHIP_SECTION_COUNT = FIELD_SCORECARD_LEADERSHIP_SECTIONS.length;

function todayIso(): string {
  // LOCAL date (not toISOString/UTC) so an evening submit west of UTC doesn't file under tomorrow.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function shortDate(iso: string): string {
  // yyyy-mm-dd (weekOf) or ISO timestamp → "Mon D".
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Resume/open route for a draft — leadership drafts have their own focused screen; project drafts the wizard. */
function draftPath(draft: ScorecardDraft, locatedOfficeId?: string | null): {
  pathname: "/(app)/scorecards/leadership/[draftId]" | "/(app)/scorecards/[draftId]";
  params: { draftId: string; officeId?: string };
} {
  const officeId = draft.editingOfficeId ?? locatedOfficeId ?? undefined;
  const params = {
    draftId: draft.id,
    ...(officeId ? { officeId } : {}),
  };
  return draft.kind === "leadership"
    ? { pathname: "/(app)/scorecards/leadership/[draftId]", params }
    : { pathname: "/(app)/scorecards/[draftId]", params };
}

export default function ScorecardsScreen() {
  const router = useRouter();
  const { fetcher, user, activeOfficeId } = useAuth();
  const ownerKey = uploadOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? undefined);

  const [drafts, setDrafts] = useState<LocatedScorecardDraft[]>([]);
  const [discardingDraftId, setDiscardingDraftId] = useState<string | null>(null);
  // Local draft reads are asynchronous and can outlive a focus session or signed-in identity. A monotonically
  // increasing generation plus current identity/focus refs prevent an older request from repopulating the list
  // after blur, sign-out, office switch, or a newer reload.
  const draftLoadGeneration = useRef(0);
  const draftsFocused = useRef(false);
  const draftIdentity = useRef<{ userId: string | null; ownerKey: string }>({ userId: null, ownerKey: "" });
  draftIdentity.current = { userId: user?.id ?? null, ownerKey };
  // Which kind of scorecard the deal picker will create when a deal is chosen. Set by the two entry buttons.
  const [pickerKind, setPickerKind] = useState<"project" | "leadership" | null>(null);
  const pickerOpen = pickerKind !== null;

  // Auto-recorded Evaluator name for a leadership card = the submitting user's own name. Trimmed; blank if
  // the user has no name on file. Shown read-only in the form — the server stamps the submitter as the
  // Evaluator, so this is display only (the value can't diverge from the persisted evaluator).
  const evaluatorName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();

  // Ensure queued scorecard evidence keeps uploading in the background even if the user never opens the
  // Capture tab this session (that's the only other place the task is registered).
  useEffect(() => {
    void registerUploadBackgroundTask();
  }, []);

  const recent = useQuery({
    queryKey: ["scorecards-recent", user?.id ?? "anon"],
    queryFn: () => getRecentScorecards(fetcher, 50),
    enabled: !!user,
  });

  // Never retain the previous account/office's local rows while authentication is being cleared or swapped.
  // This also invalidates an in-flight read before the focus effect starts the replacement identity's load.
  useEffect(() => {
    draftLoadGeneration.current += 1;
    setDrafts([]);
  }, [ownerKey, user?.id]);

  const reloadDrafts = useCallback(() => {
    const requestedUserId = user?.id ?? null;
    const requestedOwnerKey = ownerKey;
    const generation = ++draftLoadGeneration.current;
    if (!requestedOwnerKey || !requestedUserId) {
      setDrafts([]);
      return;
    }
    void listScorecardDraftsForUser(requestedUserId, requestedOwnerKey)
      .then((list) => {
        const currentIdentity = draftIdentity.current;
        if (
          !draftsFocused.current ||
          generation !== draftLoadGeneration.current ||
          currentIdentity.userId !== requestedUserId ||
          currentIdentity.ownerKey !== requestedOwnerKey
        ) {
          return;
        }
        setDrafts([...list].sort((a, b) => b.draft.updatedAt - a.draft.updatedAt));
      })
      .catch(() => undefined);
  }, [ownerKey, user?.id]);

  useFocusEffect(
    useCallback(() => {
      draftsFocused.current = true;
      reloadDrafts();
      void recent.refetch();
      return () => {
        draftsFocused.current = false;
        draftLoadGeneration.current += 1;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadDrafts]),
  );

  async function startDraft(target: FieldCaptureTarget) {
    const kind = pickerKind ?? "project";
    setPickerKind(null);
    if (!ownerKey) return;
    const id = newClientUploadId();
    const base = {
      id,
      clientSubmissionId: newSubmissionId(),
      dealId: target.id,
      dealName: target.name,
      projectNumber: target.recordNumber ?? null,
      weekOf: todayIso(),
      now: Date.now(),
    };
    // Leadership records the submitting user as the Evaluator (auto, read-only); both kinds share everything else.
    let draft =
      kind === "leadership"
        ? createLeadershipScorecardDraft({ ...base, evaluatorName })
        : createScorecardDraft(base);
    // Best-effort pre-fill of the Superintendent/PM names from the deal's assigned team, via the FIELD team
    // route the app can actually reach (the CRM /deals/:id/team route rejects the field surface). Bounded to
    // ~2s so a hanging request never blocks starting a scorecard; any failure/timeout leaves the names empty
    // (still editable). Same prefill for both kinds.
    try {
      const team = await Promise.race<DealTeamResponse>([
        getDealTeam(fetcher, target.id),
        new Promise<DealTeamResponse>((res) => setTimeout(() => res({ superintendentName: null, pmName: null }), 2000)),
      ]);
      draft = seedScorecardDraftTeam(draft, resolveScorecardTeamNames(team));
    } catch {
      /* leave super/PM empty */
    }
    await saveScorecardDraft(ownerKey, draft, Date.now());
    router.push(draftPath(draft));
  }

  function confirmDiscard(draft: ScorecardDraft, draftOwnerKey: string) {
    const editingSubmitted = isEditingScorecardDraft(draft);
    const cleanupIds = scorecardDraftEvidenceCleanupIds(draft);
    // Legacy photo drafts may have completed a partial upload before this marker existed. Treat them as
    // unsafe to discard; new drafts persist false until upload actually starts.
    if (draft.evidenceUploadAttempted || (draft.photos.length > 0 && draft.evidenceUploadAttempted !== false)) {
      // Submitted edits have an immutable server record that can authorize targeted cleanup. New cards (and
      // legacy edit drafts with no durable id ledger) still cannot prove which confirmed gallery rows belong
      // to the abandoned attempt, so keep the conservative block for those cases.
      if (!editingSubmitted || cleanupIds.length === 0) {
        Alert.alert(
          editingSubmitted ? "Finish these changes instead" : "Finish this scorecard instead",
          editingSubmitted
            ? "Evidence upload already started, but this older draft cannot identify every uploaded photo safely. Save these scorecard changes rather than discarding them."
            : "Evidence upload already started, so some photos may be in the project gallery. Complete and submit this scorecard rather than discarding it.",
        );
        return;
      }
    }
    Alert.alert(
      editingSubmitted ? "Discard changes?" : "Discard scorecard?",
      editingSubmitted
        ? cleanupIds.length > 0
          ? `This removes your local changes to ${draft.dealName}. New photos uploaded only for this edit will also be removed from the project gallery. The submitted scorecard will remain unchanged.`
          : `This removes your local changes to ${draft.dealName}. The submitted scorecard will remain unchanged.`
        : `This permanently removes the in-progress ${draft.kind === "leadership" ? "Leadership " : ""}Scorecard for ${draft.dealName}.`,
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: editingSubmitted ? "Discard changes" : "Discard",
          style: "destructive",
          onPress: () => void discardDraft(draft, draftOwnerKey),
        },
      ],
    );
  }

  async function discardDraft(draft: ScorecardDraft, draftOwnerKey: string) {
    if (discardingDraftId) return;
    setDiscardingDraftId(draft.id);
    try {
      const currentNewIds = scorecardDraftNewPhotos(draft).map((photo) => photo.clientUploadId);
      const cleanupIds = scorecardDraftEvidenceCleanupIds(draft);
      const queuedOrAttemptedIds = [...new Set([...currentNewIds, ...cleanupIds])];
      // Wait for a confirm already in flight before server reconciliation; otherwise it could land just
      // after cleanup and leave a gallery orphan even though the local edit was deleted.
      await removeQueuedUploadsAndWait(draftOwnerKey, queuedOrAttemptedIds);
      if (isEditingScorecardDraft(draft) && cleanupIds.length > 0) {
        await discardScorecardEditEvidence(fetcher, draft.editingScorecardId!, cleanupIds);
      }
      await deleteScorecardDraft(draftOwnerKey, draft.id);
      setDrafts((current) => current.filter((item) => item.draft.id !== draft.id));
    } catch {
      Alert.alert("Couldn’t discard scorecard", "Please try again.");
    } finally {
      setDiscardingDraftId(null);
    }
  }

  const submitted = recent.data?.scorecards ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={recent.isRefetching} onRefresh={() => void recent.refetch()} tintColor={theme.color.brandRed} />
        }
      >
        <View style={{ gap: theme.space.sm }}>
          <Button title="＋ Project Scorecard" onPress={() => setPickerKind("project")} />
          <Button
            title="＋ Leadership Scorecard"
            variant="ghost"
            onPress={() => setPickerKind("leadership")}
            accessibilityLabel="New Leadership Scorecard"
          />
        </View>

        {drafts.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>In progress</SectionLabel>
            {drafts.map(({ draft: d, ownerKey: draftOwnerKey, officeId: draftOfficeId }) => (
              <View key={`${draftOwnerKey}:${d.id}`} style={styles.row}>
                <Pressable
                  onPress={() => router.push(draftPath(d, draftOfficeId))}
                  style={({ pressed }) => [styles.draftResume, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${isEditingScorecardDraft(d) ? "Resume editing submitted" : "Resume"} ${d.kind === "leadership" ? "Leadership " : ""}Scorecard for ${d.dealName}`}
                >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{d.dealName}</Text>
                  <Text style={styles.rowSub}>
                    {isEditingScorecardDraft(d) ? "Editing submitted · " : ""}{d.kind === "leadership" ? "Leadership · " : ""}Week of {shortDate(d.weekOf)} · {scorecardDraftSectionsAnswered(d)}/{d.kind === "leadership" ? LEADERSHIP_SECTION_COUNT : SECTION_COUNT} scored
                  </Text>
                </View>
                <Text style={styles.resume}>{isEditingScorecardDraft(d) ? "Resume edit" : "Resume"}</Text>
                </Pressable>
                <Button
                  title={isEditingScorecardDraft(d) ? "Discard changes" : "Discard"}
                  variant="ghost"
                  onPress={() => confirmDiscard(d, draftOwnerKey)}
                  disabled={discardingDraftId !== null}
                  style={styles.discardButton}
                />
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Submitted</SectionLabel>
          {recent.isLoading ? (
            <LoadingState label="Loading scorecards…" />
          ) : submitted.length === 0 ? (
            <EmptyState title="No scorecards yet" subtitle="Tap “Project Scorecard” to score a project." />
          ) : (
            submitted.map((s) => (
              <SubmittedScorecardRow
                key={s.id}
                scorecard={s}
                onPress={() => router.push({ pathname: "/(app)/scorecards/view/[id]", params: { id: s.id } })}
              />
            ))
          )}
        </View>
      </ScrollView>

      <TargetPicker visible={pickerOpen} dealsOnly onClose={() => setPickerKind(null)} onSelect={startDraft} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, paddingBottom: theme.space.xxl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  draftResume: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.space.md },
  discardButton: { minWidth: 76 },
  rowTitle: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  rowSub: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  resume: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
});
