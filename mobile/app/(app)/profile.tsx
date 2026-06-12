import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/auth/AuthContext";
import { theme } from "../../src/theme/theme";
import { Badge, Button } from "../../src/components/ui";
import { ScreenHeader } from "../../src/components/ScreenHeader";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  rep: "Rep",
  construction: "Construction",
  field_contractor: "Field",
};

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const firstName = user?.firstName?.trim();

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.card}>
          <Text style={styles.greeting}>Hi{firstName ? `, ${firstName}` : ""} 👋</Text>
          {user?.email ? <Text style={styles.email}>{user.email}</Text> : null}
          <View style={styles.metaRow}>
            {user?.role ? <Badge label={ROLE_LABEL[user.role] ?? user.role} /> : null}
          </View>
          <Text style={styles.blurb}>
            Capture and organize jobsite photos, then build branded photo reports — all synced to T Rock CRM.
          </Text>
        </View>

        <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, flexGrow: 1 },
  card: {
    backgroundColor: theme.color.surfaceCard,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.xl,
    gap: theme.space.sm,
  },
  greeting: { fontFamily: theme.font.bold, fontSize: 22, color: theme.color.textPrimary },
  email: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted },
  metaRow: { flexDirection: "row", gap: theme.space.sm, marginTop: theme.space.xs },
  blurb: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted, marginTop: theme.space.sm, lineHeight: 20 },
});
