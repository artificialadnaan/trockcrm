import React, { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { getRecentScorecards, getDealTeam } from "../../../src/api/endpoints";
import {
  createScorecardDraft,
  resolveScorecardTeamNames,
  seedScorecardDraftTeam,
  scorecardDraftSectionsAnswered,
  type ScorecardDraft,
} from "../../../src/scorecards/draft";
import { listScorecardDrafts, saveScorecardDraft } from "../../../src/scorecards/draft-store";
import { newClientUploadId, uploadOwnerKey } from "../../../src/capture/upload-queue";
import { registerUploadBackgroundTask } from "../../../src/capture/upload-background-task";
import { newSubmissionId } from "../../../src/scorecards/ids";
import { FIELD_SCORECARD_SECTIONS } from "../../../src/scorecards/scoring";
import { Button, EmptyState, LoadingState, SectionLabel } from "../../../src/components/ui";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { RatingBadge } from "../../../src/components/RatingBadge";
import { TargetPicker } from "../../../src/components/TargetPicker";
import type { DealTeamResponse, FieldCaptureTarget, FieldScorecardSummary } from "../../../src/api/types";

const SECTION_COUNT = FIELD_SCORECARD_SECTIONS.length;

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

export default function ScorecardsScreen() {
  const router = useRouter();
  const { fetcher, user, activeOfficeId } = useAuth();
  const ownerKey = uploadOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? undefined);

  const [drafts, setDrafts] = useState<ScorecardDraft[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

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
    setPickerOpen(false);
    if (!ownerKey) return;
    const id = newClientUploadId();
    let draft = createScorecardDraft({
      id,
      clientSubmissionId: newSubmissionId(),
      dealId: target.id,
      dealName: target.name,
      projectNumber: target.recordNumber ?? null,
      weekOf: todayIso(),
      now: Date.now(),
    });
    // Best-effort pre-fill of the Superintendent/PM names from the deal's assigned team (the same
    // /deals/:id/team endpoint the web uses). ANY failure — network, 403 for a pure field_contractor,
    // or a malformed body — silently leaves the fields empty (today's behavior). It must never block or
    // crash draft creation, and it only seeds BLANK fields, so the names stay fully editable afterwards.
    // Bound the lookup to ~2s: on a poor connection a hanging /deals/:id/team must NOT block starting a
    // scorecard, so a timeout (like any error) just proceeds with empty super/PM.
    try {
      const { members } = await Promise.race<DealTeamResponse>([
        getDealTeam(fetcher, target.id),
        new Promise<DealTeamResponse>((res) => setTimeout(() => res({ members: [] }), 2000)),
      ]);
      draft = seedScorecardDraftTeam(draft, resolveScorecardTeamNames(members ?? []));
    } catch {
      /* leave super/PM empty */
    }
    await saveScorecardDraft(ownerKey, draft, Date.now());
    router.push({ pathname: "/(app)/scorecards/[draftId]", params: { draftId: id } });
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
          <Button title="＋ Project Scorecard" onPress={() => setPickerOpen(true)} />
          {/* Present now, enabled in a later phase. Kept visible + disabled with a subtle "Coming soon"
              affordance so field users know it's on the way (not missing). */}
          <View style={{ gap: 4 }}>
            <Button
              title="Leadership Scorecard"
              variant="ghost"
              disabled
              onPress={() => {}}
              accessibilityLabel="Leadership Scorecard. Coming soon."
            />
            <Text style={styles.comingSoon}>Coming soon</Text>
          </View>
        </View>

        {drafts.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>In progress</SectionLabel>
            {drafts.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => router.push({ pathname: "/(app)/scorecards/[draftId]", params: { draftId: d.id } })}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{d.dealName}</Text>
                  <Text style={styles.rowSub}>
                    Week of {shortDate(d.weekOf)} · {scorecardDraftSectionsAnswered(d)}/{SECTION_COUNT} scored
                  </Text>
                </View>
                <Text style={styles.resume}>Resume</Text>
              </Pressable>
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
            submitted.map((s: FieldScorecardSummary) => (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityLabel={`Scorecard${s.projectNumber ? ` for ${s.projectNumber}` : ""}, week of ${shortDate(s.weekOf)}, ${s.totalScore} out of 100, ${s.ratingLabel}`}
                onPress={() => router.push({ pathname: "/(app)/scorecards/view/[id]", params: { id: s.id } })}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {s.projectNumber ? `${s.projectNumber} · ` : ""}Week of {shortDate(s.weekOf)}
                  </Text>
                  <RatingBadge rating={s.rating} label={`${s.totalScore}/100 · ${s.ratingLabel}`} />
                </View>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>

      <TargetPicker visible={pickerOpen} dealsOnly onClose={() => setPickerOpen(false)} onSelect={startDraft} />
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
  rowTitle: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  rowSub: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  resume: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  comingSoon: {
    alignSelf: "center",
    fontFamily: theme.font.medium,
    fontSize: 12,
    color: theme.color.textMuted,
  },
});
