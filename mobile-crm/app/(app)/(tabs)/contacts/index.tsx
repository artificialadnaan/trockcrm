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
import { useInfiniteQuery } from "@tanstack/react-query";
import { ApiError } from "../../../../src/api/client";
import * as contactsApi from "../../../../src/api/endpoints/contacts";
import type { ContactListRow } from "../../../../src/api/types";
import { useAuth } from "../../../../src/auth/AuthContext";
import { useQueryScope } from "../../../../src/auth/useOfficeId";
import { useOffices } from "../../../../src/auth/useOffices";
import { ScreenHeader } from "../../../../src/components/ScreenHeader";
import { RetryNotice } from "../../../../src/components/RetryNotice";
import { telUrl } from "../../../../src/contact-links";
import { resolveListState } from "../../../../src/list-state";
import { openLink } from "../../../../src/lib/open-link";
import { qk } from "../../../../src/query/keys";
import { theme } from "../../../../src/theme/theme";

const PAGE_SIZE = 50;

/**
 * contacts/service.ts:469 applies its search predicate only for trimmed terms of 2+ characters. A single
 * character comes back as the UNFILTERED first page, which reads as "that letter matched everyone".
 */
const MIN_SEARCH_LENGTH = 2;

export default function ContactsListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const cacheScope = useQueryScope();
  const { activeOfficeName, refetch: refetchOffices } = useOffices();
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");

  const tooShort = search.trim().length > 0 && search.trim().length < MIN_SEARCH_LENGTH;

  const params = useMemo(() => ({ search: submitted || undefined, limit: PAGE_SIZE }), [submitted]);

  const query = useInfiniteQuery({
    queryKey: qk.contacts(cacheScope, params),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => contactsApi.listContacts(fetcher, { ...params, page: pageParam }),
    // A fixed limit with no next-page logic capped the whole directory at 50 rows — and offices have far
    // more than that, so a contact simply could not be reached by scrolling.
    getNextPageParam: (last) => {
      const p = last.pagination;
      if (!p) return undefined;
      return p.page < p.totalPages ? p.page + 1 : undefined;
    },
  });

  const contacts = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.contacts), [query.data]);
  const total = query.data?.pages[0]?.pagination?.total;

  function submitSearch() {
    const trimmed = search.trim();
    if (trimmed.length > 0 && trimmed.length < MIN_SEARCH_LENGTH) return;
    setSubmitted(trimmed);
  }

  const offline = query.error instanceof ApiError && query.error.status === 0;

  /**
   * TanStack keeps every successfully-loaded page when a LATER fetch fails, and still sets `error`. So
   * `error` alone must not drive the full-screen state: a failed page-3 request, or a failed pull-to-
   * refresh, would replace a list the user is reading — and on a phone that is their whole screen.
   * The full-screen error belongs to the case where nothing loaded at all; everything else goes inline.
   */
  // `query.data`, NOT `contacts.length`. A search that legitimately matched ZERO contacts has loaded
  // successfully, so a later failed refresh must stay inline exactly as it does for a non-empty list.
  // Keying on row count treated "loaded, and empty" as "never loaded" and replaced a refreshable empty
  // state with the blocking initial-load error — the same conflation fixed on the deals list.
  // Same tested decision the deals list uses — see resolveListState.
  const listState = resolveListState({
    isLoading: query.isLoading,
    data: query.data,
    error: query.error,
    isFetchNextPageError: query.isFetchNextPageError,
  });
  const refreshError = listState.kind === "loaded" && listState.refreshFailed;
  const pageError = listState.kind === "loaded" && listState.pageFailed;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader
        title="Contacts"
        context={activeOfficeName ?? undefined}
        right={total !== undefined ? <Text style={styles.count}>{total} total</Text> : undefined}
      />

      <TextInput
        testID="contacts-search"
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={submitSearch}
        returnKeyType="search"
        placeholder="Search name, company or email"
        placeholderTextColor={theme.color.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />
      {tooShort ? (
        <Text style={styles.searchHint}>Type at least {MIN_SEARCH_LENGTH} characters to search.</Text>
      ) : null}

      {listState.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : listState.kind === "blocking-error" ? (
        // A retry BUTTON: this branch replaces the FlatList, so there is no RefreshControl left to pull.
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>{offline ? "You're offline" : "Couldn't load contacts"}</Text>
          <Text style={styles.emptyBody}>
            {offline
              ? "Reconnect and try again."
              : query.error instanceof ApiError
                ? query.error.message
                : "Something went wrong."}
          </Text>
          <Pressable
            testID="contacts-retry"
            onPress={() => void query.refetch()}
            accessibilityRole="button"
            style={styles.retryBtn}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(c) => c.id}
          // The search field sits directly above this list, so after a search the keyboard is still up.
          // RN's default here is "never", which spends the first tap dismissing it — so opening a contact,
          // or the one-tap Call this screen exists to provide, silently needs two taps. That is the
          // headline interaction of the screen, failing in the state a user is most often in.
          keyboardShouldPersistTaps="handled"
          // `flexGrow` so the empty state centres in the viewport while the list still scrolls — which is
          // what keeps pull-to-refresh reachable with zero rows.
          contentContainerStyle={[styles.list, contacts.length === 0 && styles.listEmpty]}
          // The empty state lives INSIDE the list rather than replacing it. Swapping in a plain View
          // unmounted the RefreshControl with it, leaving no way to refetch — and refetchOnWindowFocus is
          // off, so the screen stayed empty for as long as it was mounted, even after someone else
          // created the contact being searched for.
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No contacts</Text>
              <Text style={styles.emptyBody}>
                {submitted ? "Nothing matched that search." : "This office has no contacts yet."}
              </Text>
              <Text style={styles.emptyBody}>Pull down to refresh.</Text>
            </View>
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            // NOT after a page failure. onEndReached fires repeatedly while the user sits at the bottom,
            // so without this a failed load-more retries on every scroll tick — hammering an endpoint
            // that is already failing, and fighting the explicit retry the footer offers.
            //
            // The deals list has carried this guard from the start; this one did not. Same list, same
            // hook, one copy hardened — which is the divergence that keeps producing defects here.
            if (pageError) return;
            if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          ListHeaderComponent={
            refreshError ? (
              <RetryNotice
                testID="contacts-refresh-retry"
                message="Couldn't refresh — showing saved contacts. Tap to retry."
                onRetry={() => void query.refetch()}
                placement="top"
              />
            ) : null
          }
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <ActivityIndicator color={theme.color.brandRed} style={styles.footer} />
            ) : pageError ? (
              // fetchNextPage, not refetch: reloading page 1 would silently leave the gap the user hit.
              <RetryNotice
                testID="contacts-page-retry"
                message="Couldn't load more — tap to retry"
                onRetry={() => void query.fetchNextPage()}
                placement="bottom"
              />
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              // The office label too. useOffices retries once and focus-refetching is off, so once both
              // attempts fail nothing retries it — a rep entering this tab directly was stuck with a blank
              // office and no way to recover short of restarting. Refreshing a screen refreshes what is on it.
              onRefresh={() => void Promise.all([query.refetch(), refetchOffices()])}
            />
          }
          renderItem={({ item }) => (
            <ContactRow contact={item} onOpen={() => router.push(`/(app)/contacts/${item.id}`)} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ContactRow({ contact, onOpen }: { contact: ContactListRow; onOpen: () => void }) {
  // A dialer that refuses to open must SAY so rather than look like a tap that missed.
  const [linkError, setLinkError] = useState<string | null>(null);
  const company = contactsApi.contactCompanyName(contact);
  const phone = contactsApi.contactPhone(contact);

  return (
    <View style={styles.card}>
      <Pressable
        testID={`contact-${contact.id}`}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${contact.firstName} ${contact.lastName}`}
        style={styles.cardMain}
      >
        <Text style={styles.name} numberOfLines={1}>
          {contact.firstName} {contact.lastName}
        </Text>
        {contact.jobTitle ? (
          <Text style={styles.meta} numberOfLines={1}>
            {contact.jobTitle}
          </Text>
        ) : null}
        {company ? (
          <Text style={styles.company} numberOfLines={1}>
            {company}
          </Text>
        ) : null}
      </Pressable>

      {/* Calling is the reason this screen exists on a phone — one tap from the list, no detour. */}
      {phone ? (
        <Pressable
          testID={`call-${contact.id}`}
          onPress={() => void openLink(telUrl(phone), setLinkError)}
          accessibilityRole="button"
          accessibilityLabel={`Call ${contact.firstName} ${contact.lastName}`}
          style={styles.callBtn}
          hitSlop={8}
        >
          <Text style={styles.callText}>{linkError ? "Can't call" : "Call"}</Text>
        </Pressable>
      ) : null}
    </View>
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
  searchHint: {
    marginHorizontal: theme.space.lg,
    marginBottom: theme.space.sm,
    fontFamily: theme.font.regular,
    fontSize: 13,
    color: theme.color.textMuted,
  },
  footer: { paddingVertical: theme.space.lg },
  retryBtn: {
    marginTop: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.xl,
    paddingVertical: theme.space.md,
  },
  retryText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.redText },
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
  listEmpty: { flexGrow: 1 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  cardMain: { flex: 1, gap: 2 },
  name: { fontFamily: theme.font.bold, fontSize: 16, color: theme.color.inkNavy },
  meta: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  company: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textSecondary },
  callBtn: {
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  callText: { fontFamily: theme.font.bold, fontSize: 13, color: theme.color.redText },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl, gap: theme.space.sm },
  emptyTitle: { fontFamily: theme.font.bold, fontSize: 17, color: theme.color.inkNavy },
  emptyBody: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary, textAlign: "center" },
});
