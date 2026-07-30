import React, { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ApiError } from "../../../src/api/client";
import * as directoryApi from "../../../src/api/endpoints/directory";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { useOffices } from "../../../src/auth/useOffices";
import { RetryBlock } from "../../../src/components/RetryBlock";
import { RetryNotice } from "../../../src/components/RetryNotice";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { formatLocation } from "../../../src/format";
import { useDebouncedSearch } from "../../../src/lib/use-debounced-search";
import { qk } from "../../../src/query/keys";
import { MIN_SEARCH_LENGTH, searchIsTooShort } from "../../../src/search-query";
import { theme } from "../../../src/theme/theme";

const PAGE_SIZE = 50;

/**
 * The company directory.
 *
 * This one closes a CLAIM rather than a hole. `auth/surfaces.ts` has listed `companies` as a granted
 * surface since it was written, so `accessibleSurfaces()` has been returning a destination that did
 * not exist — a promise in a table with no screen behind it. Either the claim goes or the screen
 * arrives; this is the screen.
 *
 * The card carries the server's own deal and contact counts rather than fetching its own badges: they
 * ride on the list rows precisely so a directory of two hundred companies is one request.
 */
export default function CompaniesListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const scope = useQueryScope();
  const { activeOfficeName, refetch: refetchOffices } = useOffices();
  const [search, setSearch] = useState("");
  const submitted = useDebouncedSearch(search);
  const tooShort = searchIsTooShort(search);

  const query = useQuery({
    queryKey: qk.companies(scope, { search: submitted || undefined, limit: PAGE_SIZE }),
    queryFn: () =>
      directoryApi.listCompanies(fetcher, { search: submitted || undefined, limit: PAGE_SIZE }),
  });

  const companies = query.data?.companies ?? [];
  const blocking = !query.data;
  const refreshFailed = Boolean(query.data && query.isError);
  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Companies" context={activeOfficeName ?? undefined} />

      <TextInput
        testID="companies-search"
        value={search}
        onChangeText={setSearch}
        returnKeyType="search"
        placeholder="Search company name"
        placeholderTextColor={theme.color.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />
      {tooShort ? (
        <Text style={styles.hint}>Type at least {MIN_SEARCH_LENGTH} characters to search.</Text>
      ) : null}

      {blocking && query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : blocking ? (
        <View style={styles.center}>
          <RetryBlock
            testID="companies-retry"
            title={offline ? "No signal" : "Couldn't load companies"}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <FlatList
          data={companies}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.body}
          refreshing={query.isRefetching}
          onRefresh={() => void Promise.all([query.refetch(), refetchOffices()])}
          ListHeaderComponent={
            refreshFailed ? (
              <RetryNotice
                testID="companies-refresh-failed"
                placement="top"
                message="Showing the last list — the refresh failed."
                onRetry={() => void query.refetch()}
              />
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {submitted ? `Nothing matches "${submitted}".` : "No companies in this office yet."}
            </Text>
          }
          renderItem={({ item }) => {
            const location = formatLocation(item.city, item.state);
            // The server folds these onto the row; a card must never fetch its own badges.
            const deals =
              item.activeDealCount != null && item.totalDealCount != null
                ? `${item.activeDealCount}/${item.totalDealCount} deals`
                : null;
            return (
              <Pressable
                testID={`company-${item.id}`}
                onPress={() => router.push(`/(app)/companies/${item.id}`)}
                accessibilityRole="button"
                accessibilityLabel={[item.name, item.category, location, deals]
                  .filter(Boolean)
                  .join(", ")}
                style={styles.card}
              >
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.category ? (
                  <Text accessibilityLabel={item.category} style={styles.company} numberOfLines={1}>
                    {item.category}
                  </Text>
                ) : null}
                <Text style={styles.meta} numberOfLines={1}>
                  {[location, deals].filter(Boolean).join(" · ") || "No details on file"}
                </Text>
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.lg },
  search: {
    minHeight: 44,
    margin: theme.space.lg,
    marginBottom: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.borderControl,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    ...theme.type.body,
    color: theme.color.textPrimary,
  },
  hint: { ...theme.type.small, color: theme.color.textMuted, paddingHorizontal: theme.space.lg },
  body: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.sm },
  empty: { ...theme.type.body, color: theme.color.textMuted },
  card: {
    minHeight: 44,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: 2,
  },
  name: { ...theme.type.title, color: theme.color.textPrimary },
  company: { ...theme.type.caption, textTransform: "uppercase", color: theme.color.textMuted },
  meta: { ...theme.type.small, color: theme.color.textSecondary },
});
