import React from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useGoBack } from "../../../../src/lib/go-back";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ApiError } from "../../../../src/api/client";
import * as pipelineApi from "../../../../src/api/endpoints/pipeline";
import { useAuth } from "../../../../src/auth/AuthContext";
import { useQueryScope } from "../../../../src/auth/useOfficeId";
import { BoardCard } from "../../../../src/components/BoardCard";
import { RetryNotice } from "../../../../src/components/RetryNotice";
import { resolveListState } from "../../../../src/list-state";
import { theme } from "../../../../src/theme/theme";

const PAGE_SIZE = 25;

/**
 * Every deal in one stage, paginated.
 *
 * This exists because the board is a PREVIEW: the pipeline endpoint caps each column at 15 cards, and
 * the board's footer said "open the list for all" while rendering plain, unpressable Text. Every card
 * past the fifteenth was simply unreachable — the board reported a column of 40 and could show 15 of
 * them, with no route to the rest. A truncation notice that names a destination has to have one.
 *
 * SCOPE IS CARRIED THROUGH from the board, not defaulted. Landing on "all" from a board filtered to
 * "mine" would show a different set of deals under the same stage heading and the same count the rep
 * just tapped, which reads as data corruption rather than a different filter.
 */
export default function StageDealsScreen() {
  const params = useLocalSearchParams<{ stageId: string; name?: string; scope?: string }>();
  const stageId = typeof params.stageId === "string" ? params.stageId : "";
  const stageName = typeof params.name === "string" && params.name.length > 0 ? params.name : "Stage";
  const scope: pipelineApi.PipelineScope =
    params.scope === "all" || params.scope === "watched" ? params.scope : "mine";

  const router = useRouter();

  // Carries the SCOPE. Without it, a deep-linked "all" stage list fell back to a board defaulted to
  // "mine" — a different population under the same heading, which is precisely what passing scope into
  // this screen exists to prevent. Building the href after `scope` is resolved, so the fallback and the
  // list can never disagree.
  const goBack = useGoBack(`/(app)/deals/board?scope=${scope}`);
  const { session, fetcher } = useAuth();
  const cacheScope = useQueryScope();

  const list = useInfiniteQuery({
    queryKey: ["stage-deals", cacheScope, stageId, scope],
    queryFn: ({ pageParam }) =>
      pipelineApi.getStagePage(fetcher, stageId, { scope, page: pageParam, pageSize: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) => {
      // Trust the server's totalPages when it sends one. Without pagination metadata, infer from a
      // full page — inferring from a SHORT page would stop early on an exactly-divisible total.
      const pagination = lastPage.pagination;
      if (pagination) return pagination.page < pagination.totalPages ? pagination.page + 1 : undefined;
      return lastPage.deals.length === PAGE_SIZE ? pages.length + 1 : undefined;
    },
    enabled: stageId.length > 0,
  });

  const deals = list.data?.pages.flatMap((p) => p.deals) ?? [];
  // summary.totalCount includes held cards, matching the board footer that linked here; pagination.total
  // is the same number for an unfiltered stage but is the paging count, so prefer the summary.
  const total = list.data?.pages[0]?.totalCount ?? list.data?.pages[0]?.pagination?.total;

  const state = resolveListState({
    isLoading: list.isLoading,
    data: list.data,
    error: list.error,
    isFetchNextPageError: list.isFetchNextPageError,
  });

  const offline = list.error instanceof ApiError && list.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => goBack()} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.back}>‹ Board</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {stageName}
        </Text>
        {total !== undefined ? (
          <Text style={styles.subtitle}>
            {total} {total === 1 ? "deal" : "deals"}
          </Text>
        ) : null}
      </View>

      {state.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : state.kind === "blocking-error" ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load this stage"}</Text>
          <Pressable
            testID="stage-deals-retry"
            onPress={() => void list.refetch()}
            accessibilityRole="button"
            style={styles.retryBtn}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={deals}
          keyExtractor={(d) => d.id}
          contentContainerStyle={[styles.list, deals.length === 0 && styles.listEmpty]}
          refreshControl={
            <RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} />
          }
          ListHeaderComponent={
            state.refreshFailed ? (
              <RetryNotice
                testID="stage-deals-refresh-retry"
                message="Couldn't refresh — showing saved deals. Tap to retry."
                onRetry={() => void list.refetch()}
                placement="top"
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.errorTitle}>Nothing here</Text>
              <Text style={styles.errorBody}>No deals in {stageName}.</Text>
            </View>
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            // Not while a page is already in flight, and not after one failed — retrying automatically
            // on every scroll turns one failure into a request loop the user cannot see or stop.
            if (list.hasNextPage && !list.isFetchingNextPage && !list.isFetchNextPageError) {
              void list.fetchNextPage();
            }
          }}
          ListFooterComponent={
            state.pageFailed ? (
              <RetryNotice
                testID="stage-deals-page-retry"
                message="Couldn't load more. Tap to retry."
                onRetry={() => void list.fetchNextPage()}
                placement="bottom"
              />
            ) : list.isFetchingNextPage ? (
              <ActivityIndicator style={styles.footerSpinner} color={theme.color.brandRed} />
            ) : null
          }
          renderItem={({ item }) => (
            <BoardCard
              deal={item}
              testIDPrefix="stage-card"
              canMove={pipelineApi.canMoveStage(item, session?.user.id)}
              onPress={() => router.push(`/(app)/deals/${item.id}`)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  header: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.xs },
  back: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.redText },
  title: { fontFamily: theme.font.bold, fontSize: 22, color: theme.color.inkNavy },
  subtitle: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  list: { padding: theme.space.lg, gap: theme.space.md },
  listEmpty: { flexGrow: 1 },
  footerSpinner: { paddingVertical: theme.space.lg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.space.xl,
    gap: theme.space.sm,
  },
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
  retryText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.redText },
});
