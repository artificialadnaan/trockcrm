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
 * The property directory.
 *
 * This app has been CREATING properties since field prospecting shipped — matching against them,
 * attaching every visit to one — with no way to look one up afterwards. A rep who logged a visit
 * yesterday could not open the building today, which made the capture screen's whole subject
 * unreachable from the rest of the app.
 */
export default function PropertiesListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const scope = useQueryScope();
  const { activeOfficeName, refetch: refetchOffices } = useOffices();
  const [search, setSearch] = useState("");
  const submitted = useDebouncedSearch(search);
  const tooShort = searchIsTooShort(search);

  const query = useQuery({
    queryKey: qk.properties(scope, { search: submitted || undefined, limit: PAGE_SIZE }),
    queryFn: () =>
      directoryApi.listProperties(fetcher, { search: submitted || undefined, limit: PAGE_SIZE }),
  });

  const properties = query.data?.properties ?? [];
  const blocking = !query.data;
  const refreshFailed = Boolean(query.data && query.isError);
  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
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
