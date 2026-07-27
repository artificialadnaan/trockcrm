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
        // textSecondary, NOT textMuted. On the white tab bar, #8A95A3 is 3.04:1 against the background
        // and these labels are 11pt — below the 4.5:1 floor for normal text, which on a phone held at
        // arm's length on a job site is exactly where it matters. #4B5563 is 7.6:1 and still reads as
        // clearly inactive next to the brand-red active state.
        tabBarInactiveTintColor: theme.color.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.color.surface,
          borderTopColor: theme.color.borderSubtle,
        },
        tabBarLabelStyle: { fontFamily: theme.font.semibold, fontSize: 11 },
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
