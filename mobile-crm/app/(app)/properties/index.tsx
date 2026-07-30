import React, { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ApiError } from "../../../src/api/client";
import * as directoryApi from "../../../src/api/endpoints/directory";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { useOffices } from "../../../src/auth/useOffices";
import { BackLink } from "../../../src/components/BackLink";
import { RetryBlock } from "../../../src/components/RetryBlock";
import { RetryNotice } from "../../../src/components/RetryNotice";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { formatLocation } from "../../../src/format";
import { useGoBack } from "../../../src/lib/go-back";
import { refreshFailed as pageRefreshFailed, shouldLoadNextPage } from "../../../src/paging";
import { useDebouncedSearch } from "../../../src/lib/use-debounced-search";
import { qk } from "../../../src/query/keys";
import { MIN_SEARCH_LENGTH, searchIsTooShort } from "../../../src/search-query";
import { theme } from "../../../src/theme/theme";

const PAGE_SIZE = 50;

/**
 * The property directory.
 *
 * This app has been CREATING properties since field prospecting shipped — matching against them,
 * attaching every visit to one — with no way to look one up afterwards. A rep who logged a visit
 * yesterday could not open the building today, which made the capture screen's whole subject
 * unreachable from the rest of the app.
 */
export default function PropertiesListScreen() {
  const router = useRouter();
  const goBack = useGoBack("/(app)/dashboard");
  const { fetcher } = useAuth();
  const scope = useQueryScope();
  const { activeOfficeName, refetch: refetchOffices } = useOffices();
  const [search, setSearch] = useState("");
  const submitted = useDebouncedSearch(search);
  const tooShort = searchIsTooShort(search);

  /**
   * PAGED. A single fixed page made every record past the first fifty unreachable by browsing, in an
   * office that has more than fifty — which every real one does.
   *
   * The end signal is a SHORT page rather than a total: properties answers `{ ..., total }` while
   * companies answers a differently-shaped set of aggregates, and "fewer rows than I asked for" is the
   * one thing both routes agree on.
   */
  const query = useInfiniteQuery({
    queryKey: qk.properties(scope, { search: submitted || undefined, limit: PAGE_SIZE }),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      directoryApi.listProperties(fetcher, { search: submitted || undefined, limit: PAGE_SIZE, page: pageParam }),
    getNextPageParam: (last, all) => (last.properties.length < PAGE_SIZE ? undefined : all.length + 1),
  });

  const properties = (query.data?.pages ?? []).flatMap((p) => p.properties);
  const blocking = !query.data;
  // NOT a bare `isError`: a failed page sets that too, and the header then claimed a refresh had
  // failed while the footer correctly reported the real failure. One failure must produce one message.
  const refreshFailed = pageRefreshFailed(query);
  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* A WAY BACK. This route is a sibling of (tabs), so opening it from Home pushes it OVER the tab
          navigator and the tab bar is gone — and arriving by deep link or restored navigation state
          leaves no history to gesture through either. ScreenHeader alone left no route out. */}
      <View style={styles.back}>
        <BackLink label="Home" onPress={() => goBack()} />
      </View>
      <ScreenHeader title="Properties" context={activeOfficeName ?? undefined} />

      <TextInput
        testID="properties-search"
        value={search}
        onChangeText={setSearch}
        returnKeyType="search"
        placeholder="Search name, address or city"
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
            testID="properties-retry"
            title={offline ? "No signal" : "Couldn't load properties"}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <FlatList
          keyboardShouldPersistTaps="handled"
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (shouldLoadNextPage(query)) void query.fetchNextPage();
          }}
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <ActivityIndicator color={theme.color.brandRed} style={styles.more} />
            ) : query.isFetchNextPageError ? (
              <RetryNotice
                testID="properties-more-failed"
                placement="bottom"
                message="Couldn't load more. Tap to try again."
                onRetry={() => void query.fetchNextPage()}
              />
            ) : null
          }
          data={properties}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.body}
          refreshing={query.isRefetching}
          onRefresh={() => void Promise.all([query.refetch(), refetchOffices()])}
          ListHeaderComponent={
            refreshFailed ? (
              <RetryNotice
                testID="properties-refresh-failed"
                placement="top"
                message="Showing the last list — the refresh failed."
                onRetry={() => void query.refetch()}
              />
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {submitted ? `Nothing matches "${submitted}".` : "No properties in this office yet."}
            </Text>
          }
          renderItem={({ item }) => {
            const location = formatLocation(item.city, item.state);
            return (
              <Pressable
                testID={`property-${item.id}`}
                onPress={() => router.push(`/(app)/properties/${item.id}`)}
                accessibilityRole="button"
                accessibilityLabel={[item.name, item.companyName, item.address, location]
                  .filter(Boolean)
                  .join(", ")}
                style={styles.card}
              >
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.companyName ? (
                  <Text
                    accessibilityLabel={item.companyName}
                    style={styles.company}
                    numberOfLines={1}
                  >
                    {item.companyName}
                  </Text>
                ) : null}
                <Text style={styles.meta} numberOfLines={1}>
                  {[item.address, location].filter(Boolean).join(" · ") || "No address on file"}
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
  back: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm },
  more: { paddingVertical: theme.space.lg },
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
