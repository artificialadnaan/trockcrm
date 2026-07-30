import React from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
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
  /**
   * LOADING is not the same as "we have never had a number".
   *
   * Both rendered "—" under "Pull to refresh", so the very first open of the app told a rep to retry
   * something that was already in flight. `isLoading` is true only for a first fetch with nothing
   * cached, which is exactly the case that needed its own words.
   */
  const countLoading = mine.isLoading;
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
    : countLoading
      ? "Counting…"
      : total === undefined
        ? "Pull to refresh"
        : total === 0
          ? "Nothing assigned to you yet"
          : "Tap to open your pipeline";

  const countLabel = countLoading
    ? "Your deals, counting"
    : total === undefined
      ? "Your deals, count unavailable"
      : `Your deals, ${total}`;

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
            {/* A spinner while counting, an em dash only once we have genuinely failed to get one.
                The dash meant both, so a first load looked like a permanent absence. */}
            {countLoading ? (
              <ActivityIndicator color={theme.color.brandRed} style={styles.statSpinner} />
            ) : (
              <Text style={styles.statValue}>{total === undefined ? "—" : total}</Text>
            )}
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
          {/* LOG A VISIT leads the grid, because it is the only card here that CAPTURES rather than
              browses — it is what a rep opens standing outside a building, and the one action that is
              worthless if it takes a menu to find. Gated on leads, matching where a captured visit ends
              up when it is promoted. */}
          {canAccessSurface(user.role, "leads") ? (
            <NavCard
              testID="open-prospect"
              icon="location-outline"
              label="Log a visit"
              onPress={() => router.push("/(app)/prospect")}
            />
          ) : null}
          {canAccessSurface(user.role, "deals") ? (
            <NavCard
              testID="open-deals"
              icon="briefcase-outline"
              label="Deals"
              onPress={() => router.push("/(app)/deals")}
            />
          ) : null}
          {canAccessSurface(user.role, "leads") ? (
            <NavCard
              testID="open-leads"
              icon="clipboard-outline"
              label="Leads"
              onPress={() => router.push("/(app)/leads")}
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
          {canAccessSurface(user.role, "reports") ? (
            <NavCard
              testID="open-reports"
              icon="bar-chart-outline"
              label="Reports"
              onPress={() => router.push("/(app)/reports")}
            />
          ) : null}
        </View>

        {canSwitchOffice ? (
          <Text style={styles.note}>
            You have access to more than one office. Office switching arrives with the next release.
          </Text>
        ) : null}

        <Text style={styles.scopeNote}>
          This release covers deals, leads, contacts, notes and the Monday showcase. Tasks, email and
          the rest of the reports are still to come — if something is missing it is not built yet
          rather than broken.
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
 * textMuted is 4.99:1 on `surface` — it clears the floor, but only just, and every string on this
 * screen is small supporting text read at arm's length outdoors. It was fixed on the tab bar first and
 * left behind on the screen with the most supporting text, which is the same half-applied sweep this
 * app keeps producing. textSecondary is 7.6:1 and still reads as secondary.
 */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.canvas },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  email: { ...theme.type.small, color: theme.color.textSecondary },
  statCard: {
    minHeight: 44,
    justifyContent: "center",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  // caption IS this: 11 semibold with 0.9 tracking, the token that exists so a dashboard eyebrow reads
  // as a deliberate label rather than shrunken body text. Hand-rolled at 12/1.0 it was a near-miss of
  // the thing it was imitating.
  statLabel: {
    ...theme.type.caption,
    textTransform: "uppercase",
    color: theme.color.textSecondary,
  },
  // The Numbers Lead Rule, which the board already follows and the home screen did not: `display` is
  // 34 EXTRABOLD with -0.8 tracking, reserved for exactly this — the one number a rep opens the app for.
  // It was 34 bold, the right size at the wrong weight.
  statValue: { ...theme.type.display, color: theme.color.inkNavy },
  // Reserves the display line's height so the card does not jump when the number lands.
  statSpinner: { height: theme.type.display.lineHeight, alignSelf: "flex-start" },
  statHintStale: { color: theme.color.amberText },
  statHint: { ...theme.type.small, color: theme.color.textSecondary },
  /* WRAPS. A role with all four surfaces put four flex:1 cards in one row, so at 320-360 dp "Log a
     visit" and "Contacts" squeezed to unreadable. minWidth forces the fourth onto a second line
     instead. */
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.md },
  navCard: {
    minHeight: 44,
    justifyContent: "center",
    flex: 1,
    minWidth: 140,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingVertical: theme.space.lg,
    alignItems: "center",
    gap: theme.space.sm,
  },
  navLabel: { ...theme.type.label, color: theme.color.textPrimary },
  note: { ...theme.type.small, color: theme.color.textSecondary },
  scopeNote: {
    marginTop: theme.space.sm,
    ...theme.type.small,
    color: theme.color.textSecondary,
  },
  signOut: {
    minHeight: 44,
    justifyContent: "center", marginTop: theme.space.lg, alignItems: "center", paddingVertical: theme.space.md },
  signOutText: { ...theme.type.label, color: theme.color.textSecondary },
});
