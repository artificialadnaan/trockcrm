import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../../src/auth/AuthContext";
import { canAccessSurface } from "../../../src/auth/surfaces";
import { theme } from "../../../src/theme/theme";

/**
 * The tab bar.
 *
 * Sits INSIDE the (app) stack rather than at its root, so detail screens are pushed over it and Back
 * returns to wherever the rep actually came from — see the note in (app)/_layout.tsx.
 *
 * Tabs are filtered by the SAME policy that guards the route groups, so a role never sees a tab that
 * would bounce it back. Enforcement stays in the group layouts; this is the courtesy half, exactly as
 * the web sidebar is arranged.
 */
export default function TabsLayout() {
  const { session } = useAuth();
  if (!session) return null;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.brandRed,
        // textSecondary, NOT textMuted. These labels are 11pt, and the muted token is the first thing to
        // become unreadable on a phone held at arm's length on a job site. On the dark bar #A8B2BF is
        // 8.3:1 and still reads as clearly inactive beside the brand-red active state.
        tabBarInactiveTintColor: theme.color.textSecondary,
        tabBarStyle: {
          // `chrome`, matching the board header and the app icon's own background, so the bar reads as
          // part of the frame rather than as one more card floating at the bottom of the screen.
          backgroundColor: theme.color.chrome,
          borderTopColor: theme.color.border,
        },
        tabBarLabelStyle: { fontFamily: theme.font.semibold, fontSize: 11, letterSpacing: 0.3 },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="deals"
        options={{
          title: "Deals",
          href: canAccessSurface(session.user.role, "deals") ? undefined : null,
          tabBarIcon: ({ color, size }) => <Ionicons name="briefcase-outline" color={color} size={size} />,
        }}
      />
      {/* Leads is a TAB, not a screen pushed over the tab bar.
          Every other list in this app is a tab, and the leads list was the one exception — pushed from
          the dashboard onto the (app) stack, which covers the tab bar with a header-less stack that has
          no back control of its own. A rep arriving there by deep link, or by a restored navigation
          state, had no visible route back to anywhere: canGoBack() is false, so even a Back control
          would have been inert. Being a tab is the fix the rest of the app already uses. */}
      <Tabs.Screen
        name="leads"
        options={{
          title: "Leads",
          href: canAccessSurface(session.user.role, "leads") ? undefined : null,
          tabBarIcon: ({ color, size }) => <Ionicons name="clipboard-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: "Contacts",
          href: canAccessSurface(session.user.role, "contacts") ? undefined : null,
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
