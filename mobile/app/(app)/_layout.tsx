import React from "react";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";
import { useAuth } from "../../src/auth/AuthContext";
import { theme } from "../../src/theme/theme";

function TabIcon({ emoji, focused }: { emoji: string; focused: boolean }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.55 }}>{emoji}</Text>;
}

/** Authenticated tab shell (Projects / Capture / Profile) — replaces FieldLayout. */
export default function AppLayout() {
  const { ready, token } = useAuth();

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.color.surfaceApp }}>
        <ActivityIndicator color={theme.color.brandRed} />
      </View>
    );
  }
  if (!token) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.brandRed,
        tabBarInactiveTintColor: theme.color.textMuted,
        tabBarLabelStyle: { fontFamily: theme.font.medium, fontSize: 11 },
        tabBarStyle: { backgroundColor: theme.color.surfaceCard, borderTopColor: theme.color.border },
      }}
    >
      <Tabs.Screen
        name="projects"
        options={{ title: "Projects", tabBarIcon: ({ focused }) => <TabIcon emoji="📁" focused={focused} /> }}
      />
      <Tabs.Screen
        name="capture"
        options={{ title: "Capture", tabBarIcon: ({ focused }) => <TabIcon emoji="📷" focused={focused} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: "Profile", tabBarIcon: ({ focused }) => <TabIcon emoji="👤" focused={focused} /> }}
      />
    </Tabs>
  );
}
