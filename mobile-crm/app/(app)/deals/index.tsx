import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as dealsApi from "../../../src/api/endpoints/deals";
import type { DealScope } from "../../../src/api/types";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { DealCard } from "../../../src/components/DealCard";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

const SCOPES: Array<{ key: DealScope; label: string }> = [
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
  { key: "watched", label: "Watched" },
];

const PAGE_SIZE = 50;

/**
 * The server applies its search predicate only for trimmed terms of 2+ characters. Sending a single
 * character returns the UNFILTERED first page, which looks exactly like "that one letter matched 400
 * unrelated deals" — so the client holds it back and says why.
 */
const MIN_SEARCH_LENGTH = 2;

export default function DealsListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const cacheScope = useQueryScope();
  const [scope, setScope] = useState<DealScope>("mine");
  const [search, setSearch] = useState("");

  // Only the SUBMITTED search is part of the query key. Keying on every keystroke would fire a request
  // per character against a rate-limited API (300/min/user) and thrash the cache.
  const [submittedSearch, setSubmittedSearch] = useState("");

  const tooShort = search.trim().length > 0 && search.trim().length < MIN_SEARCH_LENGTH;

  const params = useMemo(
    () => ({ scope, search: submittedSearch || undefined, limit: PAGE_SIZE }),
    [scope, submittedSearch],
  );

  const query = useInfiniteQuery({
    queryKey: qk.deals(cacheScope, params),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => dealsApi.listDeals(fetcher, { ...params, page: pageParam }),
    // Stop when the server says there are no further pages. Without this the list silently capped at the
    // first 50 while the header cheerfully reported a larger total.
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
  });

  const stagesQuery = useQuery({
    queryKey: qk.stages(cacheScope),
    queryFn: () => dealsApi.listStages(fetcher),
    // Stage config is effectively static per office; refetching it per visit is wasted budget.
    staleTime: 30 * 60_000,
  });

  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of stagesQuery.data ?? []) map.set(stage.id, stage.name);
    return map;
  }, [stagesQuery.data]);

  // Also by SLUG, because the display stage is a slug rather than an id.
  const stageNameBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of stagesQuery.data ?? []) map.set(stage.slug, stage.name);
    return map;
  }, [stagesQuery.data]);

  /**
   * The stage label for a card.
   *
   * Prefers the server's `displayStageSlug`, which is bid-board-aware: an owned deal can advance — or
   * close — in Bid Board while its CRM `stageId` still points at an earlier stage, so keying the label
   * off the id alone let the list call a closed deal "Opportunity" while the detail screen and the
   * server verdict both said otherwise. Falls back to the id when the slug is absent or is a Bid Board
   * stage with no CRM pipeline row to name it.
   */
  function stageLabelFor(deal: { displayStageSlug: string | null; stageId: string | null }) {
    if (deal.displayStageSlug) {
      const bySlug = stageNameBySlug.get(deal.displayStageSlug);
      if (bySlug) return bySlug;
    }
    return deal.stageId ? stageNameById.get(deal.stageId) : undefined;
  }

  const deals = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.deals), [query.data]);
  const total = query.data?.pages[0]?.pagination.total;

  function submitSearch() {
    const trimmed = search.trim();
    if (trimmed.length > 0 && trimmed.length < MIN_SEARCH_LENGTH) return;
    setSubmittedSearch(trimmed);
  }

  const offline = query.error instanceof ApiError && query.error.status === 0;

  /**
   * TanStack keeps every successfully-loaded page when a LATER fetch fails, and still sets `error`. So
   * `error` alone must not drive the full-screen state: a failed page-3 request, or a failed pull-to-
   * refresh, would replace a list the rep is reading — and on a phone that is their whole screen. The
   * full-screen error belongs to the case where nothing loaded at all; everything else goes inline.
   */
  const hasRows = deals.length > 0;
  const backgroundError = query.error && hasRows ? query.error : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Deals</Text>
        {total !== undefined ? <Text style={styles.count}>{total} total</Text> : null}
      </View>

      <View style={styles.scopeRow}>
        {SCOPES.map((s) => (
          <Pressable
            key={s.key}
            testID={`scope-${s.key}`}
            onPress={() => setScope(s.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === s.key }}
            style={[styles.scopePill, scope === s.key && styles.scopePillActive]}
          >
            <Text style={[styles.scopeText, scope === s.key && styles.scopeTextActive]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        testID="deals-search"
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={submitSearch}
        returnKeyType="search"
        placeholder="Search deals"
        placeholderTextColor={theme.color.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />
      {tooShort ? (
        <Text style={styles.searchHint}>Type at least {MIN_SEARCH_LENGTH} characters to search.</Text>
      ) : null}

      {query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : query.error && !hasRows ? (
        // A retry BUTTON, not "pull to retry" — this branch replaces the FlatList, so there is no
        // RefreshControl mounted to pull on. The earlier copy advertised a gesture that did not exist.
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load deals"}</Text>
          <Text style={styles.errorBody}>
            {offline
              ? "Reconnect and try again."
              : query.error instanceof ApiError
                ? query.error.message
                : "Something went wrong."}
          </Text>
          <Pressable
            testID="deals-retry"
            onPress={() => void query.refetch()}
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
          // `flexGrow` so the empty state centres in the viewport while the list still scrolls — which is
          // what keeps pull-to-refresh reachable with zero rows.
          contentContainerStyle={[styles.list, deals.length === 0 && styles.listEmpty]}
          // The empty state lives INSIDE the list rather than replacing it. Swapping in a plain View
          // unmounted the RefreshControl with it, so a rep whose filter legitimately returns nothing had
          // no way to refresh — and refetchOnWindowFocus is off, so the screen stayed empty for as long
          // as it was mounted, even after someone else created the deal they were waiting for.
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.errorTitle}>No deals</Text>
              <Text style={styles.errorBody}>
                {submittedSearch
                  ? "Nothing matched that search."
                  : scope === "mine"
                    ? "Nothing assigned to you yet. Try the All tab."
                    : scope === "watched"
                      ? "You're not watching any deals yet."
                      : "There are no deals in this office."}
              </Text>
              <Text style={styles.errorBody}>Pull down to refresh.</Text>
            </View>
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <ActivityIndicator color={theme.color.brandRed} style={styles.footer} />
            ) : backgroundError ? (
              // Retry the operation that actually failed: another page, or the refresh. Calling refetch()
              // for a failed page would silently reload page 1 and leave the gap the rep hit.
              <Pressable
                testID="deals-page-retry"
                onPress={() =>
                  void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
                }
                accessibilityRole="button"
                style={styles.footerRetry}
              >
                <Text style={styles.retryText}>
                  {query.isFetchNextPageError
                    ? "Couldn't load more — tap to retry"
                    : "Couldn't refresh — tap to retry"}
                </Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => (
            <DealCard
              deal={item}
              stageName={stageLabelFor(item)}
              onPress={(deal) => router.push(`/(app)/deals/${deal.id}`)}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  header: {
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.sm,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  title: { fontFamily: theme.font.bold, fontSize: 26, color: theme.color.inkNavy },
  count: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  scopeRow: { flexDirection: "row", gap: theme.space.sm, paddingHorizontal: theme.space.lg, paddingTop: theme.space.md },
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
  search: {
    margin: theme.space.lg,
    marginBottom: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.md,
    fontFamily: theme.font.regular,
    fontSize: 15,
    color: theme.color.textPrimary,
    backgroundColor: theme.color.surface,
  },
  searchHint: {
    marginHorizontal: theme.space.lg,
    marginBottom: theme.space.sm,
    fontFamily: theme.font.regular,
    fontSize: 13,
    color: theme.color.textMuted,
  },
  list: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.md },
  listEmpty: { flexGrow: 1 },
  footer: { paddingVertical: theme.space.lg },
  footerRetry: { paddingVertical: theme.space.lg, alignItems: "center" },
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
