import React, { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ApiError } from "../../src/api/client";
import * as searchApi from "../../src/api/endpoints/search";
import type { SearchEntityType, SearchResult } from "../../src/api/endpoints/search";
import { useAuth } from "../../src/auth/AuthContext";
import { useQueryScope } from "../../src/auth/useOfficeId";
import { canAccessSurface } from "../../src/auth/surfaces";
import { BackLink } from "../../src/components/BackLink";
import { RetryBlock } from "../../src/components/RetryBlock";
import { useGoBack } from "../../src/lib/go-back";
import { useDebouncedSearch } from "../../src/lib/use-debounced-search";
import { qk } from "../../src/query/keys";
import { MIN_SEARCH_LENGTH, searchIsTooShort } from "../../src/search-query";
import { theme } from "../../src/theme/theme";

/**
 * One box for the whole CRM.
 *
 * Every list here searches its own tab, so finding a contact meant first guessing which tab they were
 * in. On a phone, with no sidebar to scan, that guess is the whole cost of navigation.
 *
 * The server returns six typed buckets in ONE uniform row shape, so this renders a single ranked list
 * with a type badge rather than six sections a rep has to scan in turn — the point is to stop making
 * them choose a haystack before they can look.
 */
export default function SearchScreen() {
  const router = useRouter();
  const goBack = useGoBack("/(app)/dashboard");
  const { fetcher, session } = useAuth();
  const scope = useQueryScope();
  const [raw, setRaw] = useState("");
  const q = useDebouncedSearch(raw);
  const tooShort = searchIsTooShort(raw);
  const role = session?.user.role;

  const query = useQuery({
    queryKey: qk.globalSearch(scope, q),
    queryFn: () => searchApi.globalSearch(fetcher, q),
    // Nothing is asked until the floor is cleared; the server would answer empty buckets anyway, and
    // not asking is cheaper than being told nothing.
    enabled: q.length >= MIN_SEARCH_LENGTH,
  });

  /**
   * One ranked list, and only the types this app can actually open.
   *
   * `files` is dropped: there is no file surface here yet, so a row for one would be a result that
   * cannot be tapped. A search that returns things you cannot reach teaches people not to search.
   */
  const results = useMemo(() => {
    const data = query.data;
    if (!data) return [];
    const openable: SearchResult[] = [
      ...(canAccessSurface(role, "deals") ? data.deals : []),
      ...(canAccessSurface(role, "leads") ? data.leads : []),
      ...(canAccessSurface(role, "contacts") ? data.contacts : []),
      ...(canAccessSurface(role, "companies") ? data.companies : []),
      ...(canAccessSurface(role, "properties") ? data.properties : []),
    ];
    return openable.sort((a, b) => b.rank - a.rank);
  }, [query.data, role]);

  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <BackLink label="Home" onPress={() => goBack()} />
        <Text accessibilityRole="header" style={styles.title}>
          Search
        </Text>
      </View>

      <TextInput
        testID="global-search"
        value={raw}
        onChangeText={setRaw}
        returnKeyType="search"
        placeholder="Deals, leads, contacts, companies, properties"
        placeholderTextColor={theme.color.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        style={styles.search}
      />

      {tooShort ? (
        <Text style={styles.hint}>Type at least {MIN_SEARCH_LENGTH} characters to search.</Text>
      ) : null}

      {q.length < MIN_SEARCH_LENGTH ? (
        <View style={styles.center}>
          <Text style={styles.idle}>Everything in one place — start typing.</Text>
        </View>
      ) : query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : !query.data ? (
        <View style={styles.center}>
          <RetryBlock
            testID="search-retry"
            title={offline ? "No signal" : "Search failed"}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(r) => `${r.entityType}:${r.id}`}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={styles.idle}>Nothing matches &ldquo;{q}&rdquo;.</Text>}
          renderItem={({ item }) => (
            <Pressable
              testID={`search-${item.entityType}-${item.id}`}
              onPress={() => {
                const path = routeFor(item.entityType, item.id);
                if (path) router.push(path);
              }}
              accessibilityRole="button"
              accessibilityLabel={[TYPE_LABEL[item.entityType], item.primaryLabel, item.secondaryLabel]
                .filter(Boolean)
                .join(", ")}
              style={styles.row}
            >
              <View style={styles.rowHead}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.primaryLabel}
                </Text>
                <Text accessibilityLabel={TYPE_LABEL[item.entityType]} style={styles.badge}>
                  {TYPE_LABEL[item.entityType]}
                </Text>
              </View>
              {item.secondaryLabel ? (
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {item.secondaryLabel}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const TYPE_LABEL: Record<SearchEntityType, string> = {
  deal: "Deal",
  lead: "Lead",
  contact: "Contact",
  company: "Company",
  property: "Property",
  file: "File",
};

/**
 * Where a result opens IN THIS APP.
 *
 * Deliberately not `result.deepLink`: that is a web path, and following it would route a rep at a
 * screen this app does not have. Mapping the entity type is the honest translation, and a type with
 * no mobile home returns null rather than a dead tap.
 */
function routeFor(entityType: SearchEntityType, id: string): string | null {
  switch (entityType) {
    case "deal":
      return `/(app)/deals/${id}`;
    case "lead":
      return `/(app)/leads/${id}`;
    case "contact":
      return `/(app)/contacts/${id}`;
    case "company":
      return `/(app)/companies/${id}`;
    case "property":
      return `/(app)/properties/${id}`;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.canvas },
  header: {
    backgroundColor: theme.color.chrome,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.md,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.brandRed,
  },
  title: { ...theme.type.h1, color: theme.color.textPrimary, marginTop: theme.space.xs },
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.lg },
  idle: { ...theme.type.body, color: theme.color.textMuted, textAlign: "center" },
  body: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.sm },
  row: {
    minHeight: 44,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: 2,
  },
  rowHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space.md,
  },
  rowName: { flex: 1, ...theme.type.title, color: theme.color.textPrimary },
  badge: {
    ...theme.type.caption,
    textTransform: "uppercase",
    color: theme.color.textMuted,
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.sm,
    paddingVertical: 2,
    overflow: "hidden",
  },
  rowMeta: { ...theme.type.small, color: theme.color.textSecondary },
});
