import React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as dealsApi from "../../../src/api/endpoints/deals";
import { useAuth } from "../../../src/auth/AuthContext";
import { useOffices } from "../../../src/auth/useOffices";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { ApiError } from "../../../src/api/client";
import { canAccessSurface } from "../../../src/auth/surfaces";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

/**
 * Home.
 *
 * What this replaced was a debug screen: the words "Signed in", the role string, the office UUID, and
 * two link buttons. It told a rep nothing they came to the app to find out, and printed an internal
 * identifier where a person expects the name of the place they work.
 *
 * What a rep opening this on a job site actually wants is: which office am I in, how much is on my plate,
 * and is anything slipping. Everything here answers one of those.
 */
export default function DashboardScreen() {
  const router = useRouter();
  const { session, signOut, fetcher } = useAuth();
  const { activeOfficeName, canSwitchOffice, refetch: refetchOffices } = useOffices();
  const scope = useQueryScope();

  const mine = useQuery({
    queryKey: qk.deals(scope, { scope: "mine", summary: true }),
    // limit 1: this is a COUNT, and the totals ride in the pagination envelope. Pulling a full page to
    // count it would be paying for fifty rows nobody renders.
    queryFn: () => dealsApi.listDeals(fetcher, { scope: "mine", limit: 1 }),
    // Not for a role that cannot reach deals at all — construction sees no deals tab, so firing and
    // caching this request only to discard it is pure waste on a metered connection.
    enabled: Boolean(session) && canAccessSurface(session?.user.role, "deals"),
  });

  if (!session) return null;
  const { user } = session;

  const total = mine.data?.pagination.total;
  // An error is only worth reporting once the query has stopped trying; mid-retry it is not news.
  const countFailed = Boolean(mine.error) && !mine.isFetching;
  const countOffline = mine.error instanceof ApiError && mine.error.status === 0;

  /**
   * The card's supporting line, built ONCE and used for both the visible text and the spoken label.
   *
   * An explicit accessibilityLabel REPLACES the text a screen reader would otherwise assemble from the
   * card's children, so "Open my deals" was hiding the label, the number, and the stale/offline warning
   * from exactly the users who cannot glance at them. The count is the dashboard's whole point, and the
   * warning is the difference between a current figure and a stale one — neither is decoration.
   */
  const countHint = countFailed
    ? countOffline
      ? "You're offline — this may be out of date. Pull to retry."
      : "Couldn't refresh — this may be out of date. Pull to retry."
    : total === undefined
      ? "Pull to refresh"
      : total === 0
        ? "Nothing assigned to you yet"
        : "Tap to open your pipeline";

  const countLabel =
    total === undefined ? "Your deals, count unavailable" : `Your deals, ${total}`;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader
        title={firstNameOf(user.displayName)}
        // The office NAME. This rendered `activeOfficeId` — a UUID, which tells a user nothing and tells
        // a user who works across two offices nothing about which one they are looking at.
        context={activeOfficeName ?? undefined}
      />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={mine.isRefetching}
            // BOTH. Pulling to refresh a screen means "get me the current state of this screen", and the
            // office name is part of that — refreshing only the count left a transient offices failure
            // permanently stuck, since nothing else retries it.
            onRefresh={() => void Promise.all([mine.refetch(), refetchOffices()])}
          />
        }
      >
        <Text style={styles.email}>{user.email}</Text>

        {canAccessSurface(user.role, "deals") ? (
          <Pressable
            testID="home-my-deals"
            onPress={() => router.push("/(app)/deals")}
            accessibilityRole="button"
            accessibilityLabel={`${countLabel}. ${countHint}`}
            style={styles.statCard}
          >
            {/* "Your deals", not "Assigned to you": the server's `mine` scope is broader than assignment —
                it also covers deals you created, are subscribed to, or have activity on. Labelling it
                as assignment would make the number disagree with the rep's own idea of their book. */}
            <Text style={styles.statLabel}>Your deals</Text>
            <Text style={styles.statValue}>{total === undefined ? "—" : total}</Text>
            {/* No at-risk count here. It was derived from this query's rows — a limit:1 page — so it
                could only ever be 0 or 1 regardless of the real number. A wrong count is worse than
                none, and counting properly would mean pulling the whole set just to measure it. */}
            {/* Three states, not two. `total === undefined` covered "still loading" and "the request
                failed" with the same "Pull to refresh", and a failure AFTER a success is worse still:
                TanStack keeps the previous data, so the old number stayed on screen, the spinner just
                stopped, and nothing said the figure was stale. A rep plans their day off this count. */}
            <Text style={[styles.statHint, countFailed && styles.statHintStale]}>{countHint}</Text>
          </Pressable>
        ) : null}

        <View style={styles.grid}>
          {canAccessSurface(user.role, "deals") ? (
            <NavCard
              testID="open-deals"
              icon="briefcase-outline"
              label="Deals"
              onPress={() => router.push("/(app)/deals")}
            />
          ) : null}
          {canAccessSurface(user.role, "contacts") ? (
            <NavCard
              testID="open-contacts"
              icon="people-outline"
              label="Contacts"
              onPress={() => router.push("/(app)/contacts")}
            />
          ) : null}
        </View>

        {canSwitchOffice ? (
          <Text style={styles.note}>
            You have access to more than one office. Office switching arrives with the next release.
          </Text>
        ) : null}

        <Text style={styles.scopeNote}>
          This release covers deals, contacts and notes. Leads, tasks, email and reports are still to
          come — if something is missing it is not built yet rather than broken.
        </Text>

        <Pressable
          testID="sign-out"
          onPress={() => void signOut()}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          style={styles.signOut}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/** "Adnaan Iqbal" → "Adnaan". A greeting, not a record header. */
function firstNameOf(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0];
  return first || displayName;
}

function NavCard({
  testID,
  icon,
  label,
  onPress,
}: {
  testID: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.navCard}
    >
      <Ionicons name={icon} size={22} color={theme.color.brandRed} />
      <Text style={styles.navLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * NO textMuted on this screen.
 *
 * #8A95A3 is ~2.8:1 on surfaceMuted and ~3.0:1 on the stat card's white — under the 4.5:1 floor for
 * normal text, and every string here is 12-13px. It was fixed on the tab bar and the header first and
 * left behind on the screen with the most supporting text, which is the same half-applied sweep this
 * app keeps producing. textSecondary is 7.6:1 and still reads as secondary.
 */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  email: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textSecondary },
  statCard: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  statLabel: {
    fontFamily: theme.font.semibold,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: theme.color.textSecondary,
  },
  statValue: { fontFamily: theme.font.bold, fontSize: 34, color: theme.color.inkNavy },
  statHintStale: { color: theme.color.amberText },
  statHint: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textSecondary },
  grid: { flexDirection: "row", gap: theme.space.md },
  navCard: {
    flex: 1,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingVertical: theme.space.lg,
    alignItems: "center",
    gap: theme.space.sm,
  },
  navLabel: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  note: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textSecondary },
  scopeNote: {
    marginTop: theme.space.sm,
    fontFamily: theme.font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: theme.color.textSecondary,
  },
  signOut: { marginTop: theme.space.lg, alignItems: "center", paddingVertical: theme.space.md },
  signOutText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textSecondary },
});
