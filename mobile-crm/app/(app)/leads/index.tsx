import React, { useCallback, useMemo, useState } from "react";
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
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as leadsApi from "../../../src/api/endpoints/leads";
import type { LeadListItem } from "../../../src/api/types";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { LeadCard } from "../../../src/components/LeadCard";
import { RetryNotice } from "../../../src/components/RetryNotice";
import { resolveListState } from "../../../src/list-state";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

const SCOPES: Array<{ key: leadsApi.LeadScope; label: string }> = [
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
  { key: "watched", label: "Watched" },
];

/** Matches the deals list: the server only applies its search predicate at 2+ trimmed characters. */
const MIN_SEARCH_LENGTH = 2;

export default function LeadsListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const cacheScope = useQueryScope();
  const [scope, setScope] = useState<leadsApi.LeadScope>("mine");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");

  const tooShort = search.trim().length > 0 && search.trim().length < MIN_SEARCH_LENGTH;

  const params = useMemo(
    () => ({ scope, search: submittedSearch || undefined }),
    [scope, submittedSearch],
  );

  /**
   * A PLAIN query, not useInfiniteQuery.
   *
   * GET /leads takes no page or offset at all — one opt-in `limit`, clamped server-side. The reflex here
   * is to copy the deals list, which pages; that would send a `page` the route never reads and
   * re-request the same first rows forever while looking like it was loading more.
   */
  const query = useQuery({
    queryKey: qk.leads(cacheScope, params),
    queryFn: () => leadsApi.listLeads(fetcher, params),
  });

  const stagesQuery = useQuery({
    queryKey: qk.leadStages(cacheScope),
    queryFn: () => leadsApi.listLeadStages(fetcher),
    // Stage config is effectively static per office.
    staleTime: 30 * 60_000,
  });

  const stageNameById = useMemo(() => {
    const index = new Map<string, string>();
    for (const stage of stagesQuery.data ?? []) index.set(stage.id, stage.name);
    return index;
  }, [stagesQuery.data]);

  const leads = query.data ?? [];

  const handleLeadPress = useCallback(
    (lead: LeadListItem) => router.push(`/(app)/leads/${lead.id}`),
    [router],
  );

  const renderLead = useCallback(
    ({ item }: { item: LeadListItem }) => (
      <LeadCard
        lead={item}
        // The row's OWN stageName when the server sent one, falling back to the stage index. Both come
        // from the same config; preferring the row avoids a blank label while the stages query is cold.
        stageName={item.stageName ?? (item.stageId ? stageNameById.get(item.stageId) : undefined)}
        onPress={handleLeadPress}
      />
    ),
    [stageNameById, handleLeadPress],
  );

  const listState = resolveListState({
    isLoading: query.isLoading,
    data: query.data,
    error: query.error,
    // No pagination on this endpoint, so there is no next page that can fail.
    isFetchNextPageError: false,
  });

  const offline = query.error instanceof ApiError && query.error.status === 0;
  const refreshFailed = listState.kind === "loaded" && listState.refreshFailed;

  function submitSearch() {
    const trimmed = search.trim();
    if (trimmed.length > 0 && trimmed.length < MIN_SEARCH_LENGTH) return;
    setSubmittedSearch(trimmed);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Leads</Text>
        {listState.kind === "loaded" ? (
          <Text style={styles.count}>
            {leads.length}
            {/* The server caps this list, so a full page is "at least this many", not a total. Saying
                "100 leads" when there are 240 would be a number the rep plans around. */}
            {leads.length >= 100 ? "+ shown" : ""}
          </Text>
        ) : null}
      </View>

      <View style={styles.scopeRow}>
        {SCOPES.map((s) => (
          <Pressable
            key={s.key}
            testID={`lead-scope-${s.key}`}
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
        testID="leads-search"
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={submitSearch}
        returnKeyType="search"
        placeholder="Search leads"
        placeholderTextColor={theme.color.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />
      {tooShort ? <Text style={styles.hint}>Type at least {MIN_SEARCH_LENGTH} characters to search.</Text> : null}

      {listState.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : listState.kind === "blocking-error" ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load leads"}</Text>
          <Pressable
            testID="leads-retry"
            onPress={() => void query.refetch()}
            accessibilityRole="button"
            style={styles.retryBtn}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={leads}
          keyExtractor={(l) => l.id}
          contentContainerStyle={[styles.list, leads.length === 0 && styles.listEmpty]}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
          }
          ListHeaderComponent={
            refreshFailed ? (
              <RetryNotice
                testID="leads-refresh-retry"
                message="Couldn't refresh — showing saved leads. Tap to retry."
                onRetry={() => void query.refetch()}
                placement="top"
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.errorTitle}>No leads</Text>
              <Text style={styles.errorBody}>
                {submittedSearch
                  ? `Nothing matches "${submittedSearch}".`
                  : scope === "mine"
                    ? "Nothing is assigned to you. Try the All tab."
                    : "There are no leads in this office yet."}
              </Text>
            </View>
          }
          renderItem={renderLead}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.sm,
  },
  title: { fontFamily: theme.font.bold, fontSize: 26, color: theme.color.inkNavy },
  count: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
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
  search: {
    margin: theme.space.lg,
    marginBottom: theme.space.sm,
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space.md,
    fontFamily: theme.font.regular,
    fontSize: 15,
    color: theme.color.textPrimary,
  },
  hint: {
    paddingHorizontal: theme.space.lg,
    fontFamily: theme.font.regular,
    fontSize: 12,
    color: theme.color.textMuted,
  },
  list: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.md },
  listEmpty: { flexGrow: 1 },
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
  retryText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.brandRed },
});
