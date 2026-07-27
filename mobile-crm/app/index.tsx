import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "../src/auth/AuthContext";
import { theme } from "../src/theme/theme";

/**
 * Session gate. `session === undefined` means the restore from SecureStore is still in flight — routing
 * during that window would flash the login screen at an already-signed-in user on every cold start.
 */
export default function Index() {
  const { session } = useAuth();

  if (session === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.color.brandRed} />
      </View>
    );
  }

  if (!session) return <Redirect href="/login" />;

  // A must-change-password session is 403d by the server on every route except /auth/me, /auth/logout
  // and the change-password endpoint, so landing on the dashboard would show a wall of errors.
  if (session.user.mustChangePassword) return <Redirect href="/change-password" />;

  // The onboarding gate, in the same order the web app applies it (client/src/App.tsx:157-161).
  //
  // This one is CLIENT-enforced: the server sets requiresOnboarding but does not block CRM endpoints on
  // it, so skipping the check here does not produce errors — it produces full access, and the mobile app
  // silently becomes the way around a mandatory cleanup flow.
  if (session.user.requiresOnboarding) return <Redirect href="/onboarding-required" />;

  return <Redirect href="/(app)/dashboard" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceMuted },
});
