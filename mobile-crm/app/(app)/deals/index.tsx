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
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as dealsApi from "../../../src/api/endpoints/deals";
import type { DealScope } from "../../../src/api/types";
import { useAuth } from "../../../src/auth/AuthContext";
import { useOfficeId } from "../../../src/auth/useOfficeId";
import { DealCard } from "../../../src/components/DealCard";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

const SCOPES: Array<{ key: DealScope; label: string }> = [
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
  { key: "watched", label: "Watched" },
];

export default function DealsListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const officeId = useOfficeId();
  const [scope, setScope] = useState<DealScope>("mine");
  const [search, setSearch] = useState("");

  // Only the SUBMITTED search is part of the query key. Keying on every keystroke would fire a request
  // per character against a rate-limited API (300/min/user) and thrash the cache.
  const [submittedSearch, setSubmittedSearch] = useState("");

  const params = useMemo(
    () => ({ scope, search: submittedSearch || undefined, limit: 50 }),
    [scope, submittedSearch],
  );

  const query = useQuery({
    queryKey: qk.deals(officeId, params),
    queryFn: () => dealsApi.listDeals(fetcher, params),
  });

  const stagesQuery = useQuery({
    queryKey: qk.stages(officeId),
    queryFn: () => dealsApi.listStages(fetcher),
    // Stage config is effectively static per office; refetching it per visit is wasted budget.
    staleTime: 30 * 60_000,
  });

  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of stagesQuery.data ?? []) map.set(stage.id, stage.name);
    return map;
  }, [stagesQuery.data]);

  const deals = query.data?.deals ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Deals</Text>
        {query.data ? <Text style={styles.count}>{query.data.pagination.total} total</Text> : null}
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
        onSubmitEditing={() => setSubmittedSearch(search.trim())}
        returnKeyType="search"
        placeholder="Search deals"
        placeholderTextColor={theme.color.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />

      <Body
        loading={query.isLoading}
        error={query.error}
        empty={deals.length === 0}
        scope={scope}
        searching={submittedSearch.length > 0}
      >
        <FlatList
          data={deals}
          keyExtractor={(d) => d.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <DealCard
              deal={item}
              stageName={item.stageId ? stageNameById.get(item.stageId) : undefined}
              onPress={(deal) => router.push(`/(app)/deals/${deal.id}`)}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
          }
        />
      </Body>
    </SafeAreaView>
  );
}

function Body({
  loading,
  error,
  empty,
  scope,
  searching,
  children,
}: {
  loading: boolean;
  error: unknown;
  empty: boolean;
  scope: DealScope;
  searching: boolean;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.color.brandRed} />
      </View>
    );
  }

  if (error) {
    // Transport failure (status 0) is the job-site case and deserves its own words — "offline" is
    // actionable, "request failed" is not.
    const offline = error instanceof ApiError && error.status === 0;
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load deals"}</Text>
        <Text style={styles.errorBody}>
          {offline
            ? "Showing nothing until you reconnect. Pull to retry once you have signal."
            : error instanceof ApiError
              ? error.message
              : "Something went wrong."}
        </Text>
      </View>
    );
  }

  if (empty) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>No deals</Text>
        <Text style={styles.errorBody}>
          {searching
            ? "Nothing matched that search."
            : scope === "mine"
              ? "Nothing assigned to you yet. Try the All tab."
              : scope === "watched"
                ? "You're not watching any deals yet."
                : "There are no deals in this office."}
        </Text>
      </View>
    );
  }

  return <>{children}</>;
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
  list: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl, gap: theme.space.sm },
  errorTitle: { fontFamily: theme.font.bold, fontSize: 17, color: theme.color.inkNavy },
  errorBody: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary, textAlign: "center" },
});
