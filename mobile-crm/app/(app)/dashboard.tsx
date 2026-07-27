import React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as dealsApi from "../../src/api/endpoints/deals";
import { useAuth } from "../../src/auth/AuthContext";
import { useOffices } from "../../src/auth/useOffices";
import { useQueryScope } from "../../src/auth/useOfficeId";
import { canAccessSurface } from "../../src/auth/surfaces";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { qk } from "../../src/query/keys";
import { theme } from "../../src/theme/theme";

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
  const { activeOfficeName, canSwitchOffice } = useOffices();
  const scope = useQueryScope();

  const mine = useQuery({
    queryKey: qk.deals(scope, { scope: "mine", summary: true }),
    // limit 1: this is a COUNT, and the totals ride in the pagination envelope. Pulling a full page to
    // count it would be paying for fifty rows nobody renders.
    queryFn: () => dealsApi.listDeals(fetcher, { scope: "mine", limit: 1 }),
    enabled: Boolean(session),
  });

  if (!session) return null;
  const { user } = session;

  const total = mine.data?.pagination.total;
  const atRiskHint = mine.data?.deals.filter((d) => d.atRisk?.isAtRisk).length ?? 0;

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
          <RefreshControl refreshing={mine.isRefetching} onRefresh={() => void mine.refetch()} />
        }
      >
        <Text style={styles.email}>{user.email}</Text>

        {canAccessSurface(user.role, "deals") ? (
          <Pressable
            testID="home-my-deals"
            onPress={() => router.push("/(app)/deals")}
            accessibilityRole="button"
            accessibilityLabel="Open my deals"
            style={styles.statCard}
          >
            <Text style={styles.statLabel}>Assigned to you</Text>
            <Text style={styles.statValue}>{total === undefined ? "—" : total}</Text>
            <Text style={styles.statHint}>
              {total === undefined
                ? "Pull to refresh"
                : total === 0
                  ? "Nothing assigned yet"
                  : atRiskHint > 0
                    ? `${atRiskHint} flagged at risk on this page`
                    : "Tap to open your pipeline"}
            </Text>
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  email: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
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
    color: theme.color.textMuted,
  },
  statValue: { fontFamily: theme.font.bold, fontSize: 34, color: theme.color.inkNavy },
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
  note: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  scopeNote: {
    marginTop: theme.space.sm,
    fontFamily: theme.font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: theme.color.textMuted,
  },
  signOut: { marginTop: theme.space.lg, alignItems: "center", paddingVertical: theme.space.md },
  signOutText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textSecondary },
});
