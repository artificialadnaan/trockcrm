import React from "react";
import { Linking, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { theme } from "../../src/theme/theme";
import { Badge, Button, Card } from "../../src/components/ui";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { getSaveToCameraRoll, setSaveToCameraRoll } from "../../src/settings/camera-roll-setting";

const SUPPORT_HUB_URL = "https://support-hub-production.up.railway.app/";

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

  const [saveToRoll, setSaveToRoll] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    void getSaveToCameraRoll().then((value) => {
      if (active) setSaveToRoll(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleSaveToRoll = (value: boolean) => {
    setSaveToRoll(value); // optimistic — reflect the choice immediately
    void setSaveToCameraRoll(value); // persist (best-effort)
  };

  const openSupportTicket = () => {
    void Linking.openURL(SUPPORT_HUB_URL).catch(() => {
      // Opening the support hub is best-effort; if no handler can take the URL there's nothing to recover.
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />
      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.card}>
          <Text style={styles.greeting}>Hi{firstName ? `, ${firstName}` : ""} 👋</Text>
          {user?.email ? <Text style={styles.email}>{user.email}</Text> : null}
          {user?.role ? (
            <View style={styles.metaRow}>
              <Badge label={ROLE_LABEL[user.role] ?? user.role} />
            </View>
          ) : null}
          <Text style={styles.blurb}>
            Capture and organize jobsite photos, then build branded photo reports — all synced to T Rock CRM.
          </Text>
        </Card>

        <Card style={styles.card}>
          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingTitle}>Save photos to camera roll</Text>
              <Text style={styles.settingHint}>
                Keep a full-resolution backup of every capture on this device.
              </Text>
            </View>
            <Switch
              value={saveToRoll}
              onValueChange={toggleSaveToRoll}
              trackColor={{ true: theme.color.textPrimary }}
            />
          </View>
        </Card>

        <Button
          title="Create Support Ticket"
          variant="ghost"
          onPress={openSupportTicket}
          icon={<Ionicons name="help-buoy-outline" size={18} color={theme.color.textPrimary} />}
        />

        <Button title="Sign out" variant="dangerGhost" onPress={() => void signOut()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, flexGrow: 1 },
  // Spacing comes from one mechanism (the card's gap), not per-child marginTop overrides (#43).
  card: { gap: theme.space.md },
  greeting: { fontFamily: theme.font.bold, fontSize: 22, color: theme.color.textPrimary },
  email: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted },
  metaRow: { flexDirection: "row", gap: theme.space.sm },
  blurb: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted, lineHeight: 20 },
  settingRow: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  settingText: { flex: 1, gap: 2 },
  settingTitle: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textPrimary },
  settingHint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, lineHeight: 18 },
});
