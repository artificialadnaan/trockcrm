import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/auth/AuthContext";
import { theme } from "../../src/theme/theme";

/**
 * Landing screen for the auth spine. Deliberately thin: it proves a real authenticated session end to
 * end (token in the keychain, office resolved, sign-out) without pretending to be the dashboard, which
 * arrives with the deals work.
 */
export default function DashboardScreen() {
  const { session, signOut } = useAuth();
  if (!session) return null;

  const { user } = session;
  const officeId = session.activeOfficeId ?? user.officeId;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.eyebrow}>Signed in</Text>
        <Text style={styles.name}>{user.displayName}</Text>
        <Text style={styles.meta}>{user.email}</Text>

        <View style={styles.card}>
          <Row label="Role" value={user.role} />
          <Row label="Office" value={officeId} />
          {user.isRfpVoter ? <Row label="RFP voter" value="yes" /> : null}
          {user.isRfpReviewer ? <Row label="RFP reviewer" value="yes" /> : null}
        </View>

        <Text style={styles.note}>
          Deals, contacts and notes land in the next releases. This screen confirms the session works.
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  body: { padding: theme.space.xl, gap: theme.space.sm },
  eyebrow: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textMuted, letterSpacing: 1 },
  name: { fontFamily: theme.font.bold, fontSize: 24, color: theme.color.inkNavy },
  meta: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  card: {
    marginTop: theme.space.lg,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.sm,
  },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  rowValue: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  note: {
    marginTop: theme.space.lg,
    fontFamily: theme.font.regular,
    fontSize: 13,
    color: theme.color.textMuted,
  },
  signOut: {
    marginTop: theme.space.xxl,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
    backgroundColor: theme.color.surface,
  },
  signOutText: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
});
