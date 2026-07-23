import React from "react";
import { Redirect, Tabs, useGlobalSearchParams, usePathname } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { buildLoginReturnTo } from "../../src/navigation/return-to";
import { theme } from "../../src/theme/theme";

// Monochrome vector icons so the active tab icon inherits tabBarActiveTintColor
// (brand red) in lockstep with its label — the emoji glyphs never picked up the tint.
type IoniconName = React.ComponentProps<typeof Ionicons>["name"];
function TabIcon({ name, color }: { name: IoniconName; color: string }) {
  return <Ionicons name={name} size={23} color={color} />;
}

/** Authenticated tab shell (Projects / Capture / Profile) — replaces FieldLayout. */
export default function AppLayout() {
  const { ready, token } = useAuth();
  // Capture where the user was headed (e.g. the corrective-action deep link) so a required login can return
  // them there. This is the single chokepoint for BOTH a cold-start deep link (app not running → OS opens
  // the link → this layout mounts with no token) and a warm one (session expired mid-session). usePathname
  // strips the (app) group segment; useGlobalSearchParams carries any query param (e.g. the link's token).
  const pathname = usePathname();
  const params = useGlobalSearchParams();

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: theme.color.surfaceApp }}>
        <ActivityIndicator color={theme.color.brandRed} />
      </View>
    );
  }
  if (!token) {
    const returnTo = buildLoginReturnTo(pathname, params);
    return <Redirect href={returnTo ? { pathname: "/login", params: { returnTo } } : "/login"} />;
  }

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
        options={{ title: "Projects", tabBarIcon: ({ color }) => <TabIcon name="folder-outline" color={color} /> }}
      />
      <Tabs.Screen
        name="capture"
        options={{ title: "Capture", tabBarIcon: ({ color }) => <TabIcon name="camera-outline" color={color} /> }}
      />
      <Tabs.Screen
        name="scorecards"
        options={{ title: "Scorecard", tabBarIcon: ({ color }) => <TabIcon name="clipboard-outline" color={color} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: "Profile", tabBarIcon: ({ color }) => <TabIcon name="person-outline" color={color} /> }}
      />
    </Tabs>
  );
}
