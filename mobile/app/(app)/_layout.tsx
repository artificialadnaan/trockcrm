import React from "react";
import { Redirect, Tabs, useGlobalSearchParams, usePathname } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { buildLoginReturnTo } from "../../src/navigation/return-to";
import { theme } from "../../src/theme/theme";
import { walkOwnerKey } from "../../src/walkthrough/owner-key";
import { scanRecoverableWalksAtStartup } from "../../src/walkthrough/upload";

// Monochrome vector icons so the active tab icon inherits tabBarActiveTintColor
// (brand red) in lockstep with its label — the emoji glyphs never picked up the tint.
type IoniconName = React.ComponentProps<typeof Ionicons>["name"];
function TabIcon({ name, color }: { name: IoniconName; color: string }) {
  return <Ionicons name={name} size={23} color={color} />;
}

/** Authenticated tab shell (Projects / Capture / Profile) — replaces FieldLayout. */
export default function AppLayout() {
  const { ready, token, user, activeOfficeId } = useAuth();

  // Scan once for walk recordings that were interrupted before they could be queued — an app kill
  // mid-recording, or after native finalised but before the enqueue effect ran, leaves files under
  // Documents/walkthroughs/ that nothing else would ever look for.
  //
  // It runs HERE rather than on Profile because the scan is only trustworthy before anything could
  // be recording: an active walk has no manifest entry either (it is not enqueued until terminal),
  // so scanning mid-walk would report the live recording as orphaned. This layout mounts on entry
  // to the authenticated shell, before any walk screen can exist; Profile then reads the snapshot
  // rather than re-scanning.
  React.useEffect(() => {
    if (!token) return;
    const ownerKey = walkOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? null);
    if (!ownerKey) return;
    void scanRecoverableWalksAtStartup(ownerKey);
  }, [token, user?.id, user?.tenantId, activeOfficeId]);

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
      {/* __DEV__-gated diagnostic screen (renders null in release builds). Expo Router auto-adds
          any route under this layout as a tab, so without this explicit registration it ships as
          a fifth "dev-wearables" tab that a crew can tap into a blank screen. href: null keeps it
          reachable by direct navigation (e.g. for testing) without ever appearing in the tab bar. */}
      <Tabs.Screen name="dev-wearables" options={{ href: null }} />
      {/* The AI walk is entered from a project's capture flow, never from the tab bar — it needs
          a deal to attach to, and a tab has no way to carry one. Same auto-registration trap as
          above: without this it ships as a tab that opens a walk bound to nothing. */}
      <Tabs.Screen name="walk" options={{ href: null }} />
    </Tabs>
  );
}
