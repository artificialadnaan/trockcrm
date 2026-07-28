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
import { useLocalSearchParams, useRouter } from "expo-router";
import { useGoBack } from "../../../src/lib/go-back";
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
  const goBack = useGoBack("/(app)/deals");
  const { session, fetcher } = useAuth();
  const cacheScope = useQueryScope();
  /**
   * Seeded from the route, so returning here from a stage drill-down keeps the population the rep was
   * looking at. Defaulting to "mine" regardless meant backing out of an "all" stage list silently
   * changed which deals were on screen — the same set-swap the drill-down carries scope to avoid.
   */
  const params = useLocalSearchParams<{ scope?: string }>();
  const initialScope: pipelineApi.PipelineScope =
    params.scope === "all" || params.scope === "watched" ? params.scope : "mine";
  const [scope, setScope] = useState<pipelineApi.PipelineScope>(initialScope);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);

  const board = useQuery({
    queryKey: ["pipeline", cacheScope, scope],
    // Explicit scope, always — see getPipeline on why an unrecognised value is worse than omitting it.
    queryFn: () => pipelineApi.getPipeline(fetcher, { scope }),
    staleTime: 60_000,
  });

  const rawColumns = board.data?.pipelineColumns ?? [];

  /**
   * DISAMBIGUATED, not merged.
   *
   * /deals/pipeline returns active raw stages from BOTH workflow families, and migration 0045 seeds the
   * service pipeline with names that collide exactly with the standard ones — two stages both called
   * "Estimate Under Review". Rendered raw, an office with the service pipeline gets two identical chips
   * with its cards and counts split between them, and no way to tell which is which.
   *
   * The web merges them, but it does so PER DEAL: buildCanonicalDealBoardColumns dedupes every card,
   * recomputes a canonical slug from each deal's own workflowRoute and bid-board state, and regroups.
   * That is not a column-level operation, and hand-mirroring it here would be the fourth mirrored rule
   * in this app — the previous three were each wrong on their first attempt, and a wrong canonical
   * merge silently files cards under the wrong stage, which is harder to notice than duplicate chips.
   *
   * So the columns are labelled rather than combined: the split stays visible and becomes legible. The
   * real fix is the server returning canonical columns, and it is flagged as such.
   */
  const columns = useMemo(() => {
    const nameCounts = new Map<string, number>();
    for (const column of rawColumns) {
      nameCounts.set(column.stage.name, (nameCounts.get(column.stage.name) ?? 0) + 1);
    }
    return rawColumns.map((column) =>
      (nameCounts.get(column.stage.name) ?? 0) > 1 && column.stage.workflowFamily === "service_deal"
        ? { ...column, stage: { ...column.stage, name: `${column.stage.name} (Service)` } }
        : column,
    );
  }, [rawColumns]);
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
      <View style={styles.header}>
        <Pressable
          testID="board-back"
          onPress={() => goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to deals"
          hitSlop={12}
          style={styles.backBtn}
        >
          <Text style={styles.backChevron}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>PIPELINE</Text>
        {/* Balances the back control so the title stays optically centred without a second row. */}
        <View style={styles.headerSpacer} />
      </View>

      {/* A SEGMENTED control, not three loose pills. Three separate bordered pills read as three
          unrelated buttons; one recessed track with a single raised segment says "pick one of these",
          which is what this actually is. */}
      <View style={styles.segmentTrack}>
        {SCOPES.map((s) => {
          const active = scope === s.key;
          return (
            <Pressable
              key={s.key}
              testID={`board-scope-${s.key}`}
              onPress={() => setScope(s.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.segment, active && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {s.label.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
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
                  /* A TAB with an underline, not a pill. Pills all look equally "on"; an underlined tab
                     has an unambiguous selected state, and the red rule ties the selection to the brand
                     instead of tinting the whole chip pink. */
                  style={styles.stageTab}
                >
                  <View style={styles.stageTabRow}>
                    <Text
                      style={[styles.stageName, isActive && styles.stageNameActive]}
                      numberOfLines={1}
                    >
                      {col.stage.name.toUpperCase()}
                    </Text>
                    <View style={[styles.stageCountWrap, isActive && styles.stageCountWrapActive]}>
                      <Text style={[styles.stageCount, isActive && styles.stageCountActive]}>
                        {col.activeCount}
                      </Text>
                    </View>
                  </View>
                  <View style={[styles.stageUnderline, isActive && styles.stageUnderlineActive]} />
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
                  <Text style={styles.columnLabel}>{selected.stage.name.toUpperCase()} · TOTAL</Text>
                  <Text style={styles.columnValue}>{formatColumnValue(selected.totalValue)}</Text>
                  {/* TWO server facts, not a third derived from them. `activeCount` counts only the
                      STORED on_hold flag (deals/service.ts:2000-2002), while a card is badged "On hold"
                      when it is EFFECTIVELY held — which also covers a close target more than 90 days
                      out. Subtracting therefore under-counted: a column could read "10 active" with no
                      hold figure at all while one of those ten visibly carried the badge. The two
                      counts the server actually computed say enough. */}
                  <Text style={styles.columnMeta}>
                    {selected.activeCount} active of {selected.totalCount}
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
  safe: { flex: 1, backgroundColor: theme.color.canvas },

  /* Chrome — black, so the screen is framed by the brand rather than by a grey bar. */
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.color.chrome,
    paddingHorizontal: theme.space.sm,
    paddingBottom: theme.space.md,
    paddingTop: theme.space.xs,
    // The red rule under the chrome. One 2px line does more brand work here than tinting a whole
    // surface, and it separates the header from the canvas without a grey divider.
    borderBottomWidth: 2,
    borderBottomColor: theme.color.brandRed,
  },
  backBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backChevron: { fontFamily: theme.font.bold, fontSize: 30, lineHeight: 34, color: theme.color.textPrimary },
  headerTitle: { flex: 1, textAlign: "center", ...theme.type.caption, fontSize: 12, color: theme.color.textPrimary },
  headerSpacer: { width: 44 },

  /* Scope — one recessed track, one raised segment. */
  segmentTrack: {
    flexDirection: "row",
    margin: theme.space.lg,
    marginBottom: theme.space.sm,
    padding: 3,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  segment: {
    flex: 1,
    // 44, not 38. The iOS HIG minimum is a 44pt target, and a control sized to LOOK right rather than
    // to be hit is the specific way a redesign makes an app worse for someone wearing gloves.
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  segmentActive: { backgroundColor: theme.color.surfaceRaised, ...theme.elevation.card },
  segmentText: { ...theme.type.caption, color: theme.color.textMuted },
  segmentTextActive: { color: theme.color.textPrimary },

  /* Stage selector — underlined tabs. */
  stageRow: { paddingHorizontal: theme.space.lg, gap: theme.space.xl, alignItems: "flex-end" },
  // Same 44pt rule. The underline sits at the bottom of the tab, so the padding above it is what makes
  // the target tall enough without pushing the rule away from the label.
  stageTab: { minHeight: 44, justifyContent: "flex-end", paddingTop: theme.space.md },
  stageTabRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
  stageName: { ...theme.type.caption, color: theme.color.textMuted },
  stageNameActive: { color: theme.color.textPrimary },
  stageCountWrap: {
    minWidth: 22,
    alignItems: "center",
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  stageCountWrapActive: { backgroundColor: theme.color.brandRed, borderColor: theme.color.brandRed },
  stageCount: { fontFamily: theme.font.bold, fontSize: 11, color: theme.color.textMuted },
  stageCountActive: { color: theme.color.onBrand },
  stageUnderline: { height: 2, marginTop: theme.space.sm, backgroundColor: "transparent" },
  stageUnderlineActive: { backgroundColor: theme.color.brandRed },

  noticeWrap: { paddingHorizontal: theme.space.lg },

  /* Column header — the one place a big number belongs. */
  columnSummary: { paddingBottom: theme.space.lg, gap: 2 },
  columnLabel: { ...theme.type.caption, color: theme.color.textMuted },
  columnValue: {
    ...theme.type.display,
    color: theme.color.textPrimary,
    // Tabular so the figure does not jitter horizontally when switching stages.
    fontVariant: ["tabular-nums"],
  },
  columnMeta: { ...theme.type.caption, color: theme.color.textSecondary },

  list: { padding: theme.space.lg, paddingTop: theme.space.lg, gap: theme.space.md },
  listEmpty: { flexGrow: 1 },
  previewNoteBtn: {
    marginTop: theme.space.md,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceMuted,
  },
  previewNote: { ...theme.type.caption, color: theme.color.textSecondary },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl, gap: theme.space.sm },
  errorTitle: { ...theme.type.h2, color: theme.color.textPrimary },
  errorBody: { ...theme.type.body, color: theme.color.textSecondary, textAlign: "center" },
  retryBtn: {
    marginTop: theme.space.md,
    minHeight: 48,
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.brandRed,
    paddingHorizontal: theme.space.xxl,
    ...theme.elevation.card,
  },
  // White on brandRed is 4.8:1. The old outline-only button was red-on-near-black at 3.7:1, which is
  // under the floor for a 14px label — the primary action was the least readable thing on the screen.
  retryText: { ...theme.type.label, color: theme.color.onBrand, textAlign: "center" },
});
