import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as pipelineApi from "../../../src/api/endpoints/pipeline";
import type { DealListItem } from "../../../src/api/types";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { BoardCard } from "../../../src/components/BoardCard";
import { RetryNotice } from "../../../src/components/RetryNotice";
import { resolveListState } from "../../../src/list-state";
import { theme } from "../../../src/theme/theme";

/**
 * The pipeline board.
 *
 * A phone cannot show a desktop kanban, so this is one column at a time with a stage selector across
 * the top — the same information, navigated rather than scanned. Horizontal drag-between-columns is
 * deliberately absent: the move is a deliberate, gated action with required reasons, not something to
 * trigger with a thumb on a ladder.
 */
const SCOPES: Array<{ key: pipelineApi.PipelineScope; label: string }> = [
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
  { key: "watched", label: "Watched" },
];

export default function PipelineBoardScreen() {
  const router = useRouter();
  const { session, fetcher } = useAuth();
  const cacheScope = useQueryScope();
  const [scope, setScope] = useState<pipelineApi.PipelineScope>("mine");
  const [activeStageId, setActiveStageId] = useState<string | null>(null);

  const board = useQuery({
    queryKey: ["pipeline", cacheScope, scope],
    // Explicit scope, always — see getPipeline on why an unrecognised value is worse than omitting it.
    queryFn: () => pipelineApi.getPipeline(fetcher, { scope }),
    staleTime: 60_000,
  });

  const columns = board.data?.pipelineColumns ?? [];
  const selected = useMemo(
    () => columns.find((c) => c.stage.id === activeStageId) ?? columns[0] ?? null,
    [columns, activeStageId],
  );

  const state = resolveListState({
    isLoading: board.isLoading,
    data: board.data,
    error: board.error,
    isFetchNextPageError: false,
  });

  const offline = board.error instanceof ApiError && board.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* An explicit way out. The deals Stack sets headerShown: false, so the ONLY way back off this
          screen was the iOS edge-swipe — which switch-control and other assistive-technology users
          cannot perform, leaving them stuck on the board. The detail and stage-list screens already
          carry one; this was the screen that didn't. */}
      <Pressable
        testID="board-back"
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back to deals"
        hitSlop={8}
        style={styles.backRow}
      >
        <Text style={styles.back}>‹ Deals</Text>
      </Pressable>

      <View style={styles.scopeRow}>
        {SCOPES.map((s) => (
          <Pressable
            key={s.key}
            testID={`board-scope-${s.key}`}
            onPress={() => setScope(s.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === s.key }}
            style={[styles.scopePill, scope === s.key && styles.scopePillActive]}
          >
            <Text style={[styles.scopeText, scope === s.key && styles.scopeTextActive]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      {state.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : state.kind === "blocking-error" ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load the board"}</Text>
          <Pressable
            testID="board-retry"
            onPress={() => void board.refetch()}
            accessibilityRole="button"
            style={styles.retryBtn}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : columns.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>No stages</Text>
          <Text style={styles.errorBody}>
            {scope === "mine"
              ? "Nothing is assigned to you. Try the All tab."
              : "This office has no configured pipeline stages."}
          </Text>
        </View>
      ) : (
        <>
          {/* The stage selector. Counts are the SERVER's — activeCount excludes held deals, which is
              what the web column headers show, so the two cannot disagree. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stageRow}
          >
            {columns.map((col) => {
              const isActive = selected?.stage.id === col.stage.id;
              return (
                <Pressable
                  key={col.stage.id}
                  testID={`board-stage-${col.stage.slug}`}
                  onPress={() => setActiveStageId(col.stage.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  style={[styles.stageChip, isActive && styles.stageChipActive]}
                >
                  <Text style={[styles.stageName, isActive && styles.stageNameActive]}>
                    {col.stage.name}
                  </Text>
                  <Text style={[styles.stageCount, isActive && styles.stageCountActive]}>
                    {col.activeCount}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {state.kind === "loaded" && state.refreshFailed ? (
            <View style={styles.noticeWrap}>
              <RetryNotice
                testID="board-refresh-retry"
                message="Couldn't refresh — showing saved board. Tap to retry."
                onRetry={() => void board.refetch()}
                placement="top"
              />
            </View>
          ) : null}

          {selected ? (
            <FlatList
              // Cards live at column.deals. The web app renames this to `cards` client-side; copying
              // that name gives an empty board on a perfectly good response.
              data={selected.deals}
              keyExtractor={(d) => d.id}
              contentContainerStyle={[styles.list, selected.deals.length === 0 && styles.listEmpty]}
              refreshControl={
                <RefreshControl refreshing={board.isRefetching} onRefresh={() => void board.refetch()} />
              }
              ListHeaderComponent={
                <View style={styles.columnSummary}>
                  <Text style={styles.columnValue}>{formatColumnValue(selected.totalValue)}</Text>
                  <Text style={styles.columnMeta}>
                    {selected.activeCount} active
                    {selected.totalCount > selected.activeCount
                      ? ` · ${selected.totalCount - selected.activeCount} on hold`
                      : ""}
                  </Text>
                </View>
              }
              ListEmptyComponent={
                <View style={styles.center}>
                  <Text style={styles.errorTitle}>Nothing here</Text>
                  <Text style={styles.errorBody}>No deals in {selected.stage.name}.</Text>
                </View>
              }
              ListFooterComponent={
                // The board is a PREVIEW — the server caps cards per column and there is no
                // "load more" here, so saying so is the difference between "that's all of them" and a
                // silent truncation the rep plans around.
                // totalCount, NOT activeCount. The preview includes held cards while activeCount
                // excludes them, so a column of 20 (15 active + 5 held) returning a 15-card preview
                // compared 15 > 15 and hid this — presenting a truncated column as complete, which is
                // exactly the silent-truncation the note exists to prevent.
                //
                // PRESSABLE, and it goes somewhere. This was plain Text naming a list that had no
                // route, so the cards it was counting stayed unreachable — a truncation notice that
                // points nowhere just tells the rep what they are missing.
                selected.deals.length > 0 && selected.totalCount > selected.deals.length ? (
                  <Pressable
                    testID="board-open-stage-list"
                    onPress={() =>
                      router.push({
                        pathname: "/(app)/deals/stage/[stageId]",
                        // Scope travels with it — a stage list under a different filter than the board
                        // the rep just tapped would contradict the count they tapped on.
                        params: { stageId: selected.stage.id, name: selected.stage.name, scope },
                      })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Show all ${selected.totalCount} deals in ${selected.stage.name}`}
                    style={styles.previewNoteBtn}
                  >
                    <Text style={styles.previewNote}>
                      Showing {selected.deals.length} of {selected.totalCount} — see all
                    </Text>
                  </Pressable>
                ) : null
              }
              renderItem={({ item }) => (
                <BoardCard
                  deal={item}
                  canMove={pipelineApi.canMoveStage(item, session?.user.id)}
                  onPress={() => router.push(`/(app)/deals/${item.id}`)}
                />
              )}
            />
          ) : null}
        </>
      )}
    </SafeAreaView>
  );
}

/** Column totals arrive as a number already summed server-side with the canonical hold rule applied. */
function formatColumnValue(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  return total.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  backRow: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm, minHeight: 44, justifyContent: "center" },
  back: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.brandRed },
  scopeRow: {
    flexDirection: "row",
    gap: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.sm,
  },
  scopePill: {
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    backgroundColor: theme.color.surface,
  },
  scopePillActive: { backgroundColor: theme.color.inkNavy, borderColor: theme.color.inkNavy },
  scopeText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textSecondary },
  scopeTextActive: { color: theme.color.textInverse },
  stageRow: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md, gap: theme.space.sm },
  stageChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  stageChipActive: { borderColor: theme.color.brandRed, backgroundColor: theme.color.redSurface },
  stageName: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textSecondary },
  stageNameActive: { color: theme.color.brandRedDeep },
  stageCount: { fontFamily: theme.font.bold, fontSize: 13, color: theme.color.textMuted },
  stageCountActive: { color: theme.color.brandRedDeep },
  noticeWrap: { paddingHorizontal: theme.space.lg },
  columnSummary: { paddingBottom: theme.space.md },
  columnValue: { fontFamily: theme.font.bold, fontSize: 24, color: theme.color.inkNavy },
  columnMeta: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  list: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.md },
  listEmpty: { flexGrow: 1 },
  previewNoteBtn: { paddingVertical: theme.space.sm, minHeight: 44, justifyContent: "center" },
  previewNote: {
    paddingTop: theme.space.md,
    textAlign: "center",
    fontFamily: theme.font.regular,
    fontSize: 12,
    color: theme.color.textMuted,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl, gap: theme.space.sm },
  errorTitle: { fontFamily: theme.font.bold, fontSize: 17, color: theme.color.inkNavy },
  errorBody: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary, textAlign: "center" },
  retryBtn: {
    marginTop: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.md,
  },
  retryText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.brandRed },
});
