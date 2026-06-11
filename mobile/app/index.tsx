import React from "react";
import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { theme } from "../src/theme/theme";

/** Boot gate: wait for the persisted session, then route to the app or login. */
export default function Index() {
  const { ready, token } = useAuth();
  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.color.surfaceApp }}>
        <ActivityIndicator color={theme.color.brandRed} />
      </View>
    );
  }
  return <Redirect href={token ? "/(app)/projects" : "/login"} />;
}
