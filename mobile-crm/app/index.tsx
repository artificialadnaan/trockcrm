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

  return <Redirect href="/(app)/dashboard" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceMuted },
});
