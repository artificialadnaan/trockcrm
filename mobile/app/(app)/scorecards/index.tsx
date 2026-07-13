import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { getRecentScorecards, getDealTeam } from "../../../src/api/endpoints";
import {
  createScorecardDraft,
  createLeadershipScorecardDraft,
  resolveScorecardTeamNames,
  seedScorecardDraftTeam,
  scorecardDraftSectionsAnswered,
  type ScorecardDraft,
} from "../../../src/scorecards/draft";
import { listScorecardDrafts, saveScorecardDraft, deleteScorecardDraft } from "../../../src/scorecards/draft-store";
import { newClientUploadId, removeQueuedUploads, uploadOwnerKey } from "../../../src/capture/upload-queue";
import { registerUploadBackgroundTask } from "../../../src/capture/upload-background-task";
import { newSubmissionId } from "../../../src/scorecards/ids";
import { FIELD_SCORECARD_SECTIONS, FIELD_SCORECARD_LEADERSHIP_SECTIONS } from "../../../src/scorecards/scoring";
import { Button, EmptyState, LoadingState, SectionLabel } from "../../../src/components/ui";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { RatingBadge } from "../../../src/components/RatingBadge";
import { TargetPicker } from "../../../src/components/TargetPicker";
import type { DealTeamResponse, FieldCaptureTarget, FieldScorecardSummary } from "../../../src/api/types";

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
function draftPath(draft: ScorecardDraft): {
  pathname: "/(app)/scorecards/leadership/[draftId]" | "/(app)/scorecards/[draftId]";
  params: { draftId: string };
} {
  return draft.kind === "leadership"
    ? { pathname: "/(app)/scorecards/leadership/[draftId]", params: { draftId: draft.id } }
    : { pathname: "/(app)/scorecards/[draftId]", params: { draftId: draft.id } };
}

export default function ScorecardsScreen() {
  const router = useRouter();
  const { fetcher, user, activeOfficeId } = useAuth();
  const ownerKey = uploadOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? undefined);

  const [drafts, setDrafts] = useState<ScorecardDraft[]>([]);
  const [discardingDraftId, setDiscardingDraftId] = useState<string | null>(null);
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

  const reloadDrafts = useCallback(() => {
    if (!ownerKey) return;
    void listScorecardDrafts(ownerKey).then((list) =>
      setDrafts([...list].sort((a, b) => b.updatedAt - a.updatedAt)),
    );
  }, [ownerKey]);

  useFocusEffect(
    useCallback(() => {
      reloadDrafts();
      void recent.refetch();
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

  function confirmDiscard(draft: ScorecardDraft) {
    Alert.alert(
      "Discard scorecard?",
      `This permanently removes the in-progress ${draft.kind === "leadership" ? "Leadership " : ""}Scorecard for ${draft.dealName}.`,
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => void discardDraft(draft),
        },
      ],
    );
  }

  async function discardDraft(draft: ScorecardDraft) {
    if (!ownerKey || discardingDraftId) return;
    setDiscardingDraftId(draft.id);
    try {
      // Remove still-queued uploads before deleting the local draft. Uploaded evidence is only linked when a
      // scorecard is submitted, so this cannot remove evidence from a completed scorecard.
      await removeQueuedUploads(ownerKey, draft.photos.map((photo) => photo.clientUploadId));
      await deleteScorecardDraft(ownerKey, draft.id);
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
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
            {drafts.map((d) => (
              <View key={d.id} style={styles.row}>
                <Pressable
                  onPress={() => router.push(draftPath(d))}
                  style={({ pressed }) => [styles.draftResume, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Resume ${d.kind === "leadership" ? "Leadership " : ""}Scorecard for ${d.dealName}`}
                >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{d.dealName}</Text>
                  <Text style={styles.rowSub}>
                    {d.kind === "leadership" ? "Leadership · " : ""}Week of {shortDate(d.weekOf)} · {scorecardDraftSectionsAnswered(d)}/{d.kind === "leadership" ? LEADERSHIP_SECTION_COUNT : SECTION_COUNT} scored
                  </Text>
                </View>
                <Text style={styles.resume}>Resume</Text>
                </Pressable>
                <Button
                  title="Discard"
                  variant="ghost"
                  onPress={() => confirmDiscard(d)}
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
            submitted.map((s: FieldScorecardSummary) => {
              // Leadership cards are scored by the 4-category average out of 10; project cards keep the
              // 0–100 total. averageScore is populated for leadership (and V2) cards; fall back to
              // totalScore/10 defensively so a missing value never renders "undefined/10".
              const isLeadership = s.kind === "leadership";
              const scoreText = isLeadership
                ? `${(s.averageScore ?? s.totalScore / 10).toFixed(1)}/10`
                : `${s.totalScore}/100`;
              return (
                <Pressable
                  key={s.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${isLeadership ? "Leadership scorecard" : "Scorecard"}${s.projectNumber ? ` for ${s.projectNumber}` : ""}, week of ${shortDate(s.weekOf)}, ${scoreText}, ${s.ratingLabel}`}
                  onPress={() => router.push({ pathname: "/(app)/scorecards/view/[id]", params: { id: s.id } })}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {isLeadership ? "Leadership · " : ""}{s.projectNumber ? `${s.projectNumber} · ` : ""}Week of {shortDate(s.weekOf)}
                    </Text>
                    <RatingBadge rating={s.rating} label={`${scoreText} · ${s.ratingLabel}`} />
                  </View>
                </Pressable>
              );
            })
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
