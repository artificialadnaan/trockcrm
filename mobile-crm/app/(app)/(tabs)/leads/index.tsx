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
import { ApiError } from "../../../../src/api/client";
import * as leadsApi from "../../../../src/api/endpoints/leads";
import type { LeadListItem } from "../../../../src/api/types";
import { useAuth } from "../../../../src/auth/AuthContext";
import { useQueryScope } from "../../../../src/auth/useOfficeId";
import { LeadCard } from "../../../../src/components/LeadCard";
import { RetryNotice } from "../../../../src/components/RetryNotice";
import { resolveListState } from "../../../../src/list-state";
import { qk } from "../../../../src/query/keys";
import { theme } from "../../../../src/theme/theme";

/**
 * NO "Watched" here, unlike the deals list.
 *
 * `readListScope` coerces anything that is not mine/team/all to "mine", silently and with a 200, so a
 * Watched pill would have shown the rep their OWN leads under someone else's label — a filter that
 * looks applied and is not. Copying the deals scope list across was the mistake; leads has no
 * subscription predicate server-side.
 */
const SCOPES: Array<{ key: leadsApi.LeadScope; label: string }> = [
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
];

/**
 * Open vs closed, as an explicit choice rather than a default.
 *
 * The list defaults to ACTIVE because the route caps at 100 rows by updatedAt, and a terminal lead is
 * updated at the moment it closes — so mixing them in lets a week of conversions push older open leads
 * out of a list that has no pagination. Closed leads are still worth reaching (a converted lead is how
 * a rep finds the deal it became), so they get their own filter instead of crowding the default one.
 */
const LIFECYCLES: Array<{ key: "true" | "false"; label: string }> = [
  { key: "true", label: "Open" },
  { key: "false", label: "Closed" },
];

/** Matches the deals list: the server only applies its search predicate at 2+ trimmed characters. */
const MIN_SEARCH_LENGTH = 2;

export default function LeadsListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const cacheScope = useQueryScope();
  const [scope, setScope] = useState<leadsApi.LeadScope>("mine");
  const [lifecycle, setLifecycle] = useState<"true" | "false">("true");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");

  const tooShort = search.trim().length > 0 && search.trim().length < MIN_SEARCH_LENGTH;

  const params = useMemo(
    () => ({ scope, search: submittedSearch || undefined, isActive: lifecycle }),
    [scope, submittedSearch, lifecycle],
  );

  /**
   * A PLAIN query, not useInfiniteQuery.
   *
   * GET /leads takes no page or offset at all — one opt-in `limit`, clamped server-side. The reflex here
   * is to copy the deals list, which pages; that would send a `page` the route never reads and
   * re-request the same first rows forever while looking like it was loading more.
   *
   * CLOSED goes through listClosedLeads, which asks for the two terminal statuses separately. An
   * `isActive: "false"` filter is not the closed set: archive tombstones are inactive with an "open"
   * status, and because the server sorts by updatedAt and caps at 100 BEFORE the client sees anything,
   * removing them afterwards left a tab that could render empty while the converted and disqualified
   * leads it exists to show sat just past the cut. Filtering after a truncation cannot recover what the
   * truncation dropped.
   */
  const query = useQuery({
    queryKey: qk.leads(cacheScope, params),
    queryFn: () =>
      lifecycle === "false"
        ? leadsApi.listClosedLeads(fetcher, { scope, search: submittedSearch || undefined })
        : leadsApi.listLeads(fetcher, params),
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

  // Tombstones are excluded by the QUERY now (see listClosedLeads), not trimmed off the response, so
  // there is nothing left to filter here.
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

      <View style={styles.scopeRow}>
        {LIFECYCLES.map((l) => (
          <Pressable
            key={l.key}
            testID={`lead-lifecycle-${l.key}`}
            onPress={() => setLifecycle(l.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: lifecycle === l.key }}
            style={[styles.scopePill, lifecycle === l.key && styles.scopePillActive]}
          >
            <Text style={[styles.scopeText, lifecycle === l.key && styles.scopeTextActive]}>
              {l.label}
            </Text>
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
          // Without this, the first tap on a search result is eaten dismissing the keyboard and the rep
          // has to tap twice with no explanation. The deals list already does this for the same flow.
          keyboardShouldPersistTaps="handled"
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
                  : lifecycle === "false"
                    ? "No converted or disqualified leads here."
                    : scope === "mine"
                      ? "Nothing is assigned to you. Try the All tab."
                      : "There are no open leads in this office."}
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
  // surfaceRaised, NOT inkNavy. inkNavy is a TEXT colour on the dark theme (it points at the
  // primary text), so using it as a fill made the selected pill a light slab with white text on
  // it — invisible. A raised surface is what "selected" means everywhere else in this app.
  scopePillActive: { backgroundColor: theme.color.surfaceRaised, borderColor: theme.color.borderStrong },
  scopeText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textSecondary },
  scopeTextActive: { color: theme.color.textPrimary },
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
