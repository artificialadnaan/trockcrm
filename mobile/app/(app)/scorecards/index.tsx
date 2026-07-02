import React, { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { getRecentScorecards } from "../../../src/api/endpoints";
import {
  createScorecardDraft,
  scorecardDraftSectionsAnswered,
  type ScorecardDraft,
} from "../../../src/scorecards/draft";
import { listScorecardDrafts, saveScorecardDraft } from "../../../src/scorecards/draft-store";
import { newClientUploadId, uploadOwnerKey } from "../../../src/capture/upload-queue";
import { FIELD_SCORECARD_SECTIONS } from "../../../src/scorecards/scoring";
import { Button, EmptyState, LoadingState, SectionLabel } from "../../../src/components/ui";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { RatingBadge } from "../../../src/components/RatingBadge";
import { TargetPicker } from "../../../src/components/TargetPicker";
import type { FieldCaptureTarget, FieldScorecardSummary } from "../../../src/api/types";

const SECTION_COUNT = FIELD_SCORECARD_SECTIONS.length;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
    const draft = createScorecardDraft({
      id,
      clientSubmissionId: newClientUploadId(),
      dealId: target.id,
      dealName: target.name,
      projectNumber: target.recordNumber ?? null,
      weekOf: todayIso(),
      now: Date.now(),
    });
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
        <Button title="＋ New scorecard" onPress={() => setPickerOpen(true)} />

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
            <EmptyState title="No scorecards yet" subtitle="Tap “New scorecard” to score a project." />
          ) : (
            submitted.map((s: FieldScorecardSummary) => (
              <View key={s.id} style={styles.row}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{s.projectNumber ? `${s.projectNumber} · ` : ""}Week of {shortDate(s.weekOf)}</Text>
                  <RatingBadge rating={s.rating} label={`${s.totalScore}/100 · ${s.ratingLabel}`} />
                </View>
              </View>
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
});
