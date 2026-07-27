import React from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { canAccessSurface } from "../../src/auth/surfaces";
import { formStyles } from "../../src/theme/formStyles";
import { theme } from "../../src/theme/theme";

/**
 * The authenticated shell: auth gates, then the tab bar.
 *
 * Gates run in a deliberate order — restoring, signed-out, forced password change, onboarding — and each
 * one owns exactly one redirect. The tab bar renders only once every gate has passed, so no tab can be
 * reached by a session that should have been sent elsewhere.
 */
export default function AppLayout() {
  const { session, gate } = useAuth();

  // A SPINNER, not a blank screen. Two things land here: the SecureStore restore on cold start, and
  // the gate check below with its 3s grace. Rendering nothing for up to that long reads as a crash or a
  // frozen app — on a job site the reasonable response is to force-quit, which restarts the wait.
  if (session === undefined) return <Restoring />;
  if (!session) return <Redirect href="/login" />;
  if (session.user.mustChangePassword) return <Redirect href="/change-password" />;

  /**
   * Wait for the onboarding flag to be CONFIRMED before opening the authenticated app.
   *
   * Unlike mustChangePassword — which the server enforces by 403ing every other route, so a stale `false`
   * corrects itself — requiresOnboarding is enforced only here. A session cached before the user was
   * assigned cleanup work carries `false`, and publishing it immediately would let them straight past a
   * gate the server will never close behind them.
   *
   * "stale" deliberately falls through rather than blocking. The check is bounded (GATE_GRACE_MS) and
   * retried on a timer and on every foreground, so an unreachable server degrades to the cached answer
   * instead of locking a rep out of the CRM from a site with no signal. That is the honest trade: this
   * gate is an operational cleanup nag, not a security boundary, and the server treats it as one too.
   */
  if (gate === "checking") return <Restoring />;

  // Enforced HERE, not only on the index route: index is just the launch redirect, and a deep link or a
  // restored navigation state can mount a screen inside this group without ever passing through it. A
  // gate that only guards the front door is not a gate.
  if (session.user.requiresOnboarding) return <Redirect href="/onboarding-required" />;

  /**
   * TABS, not a Stack. The app shipped as a single Stack with a landing screen that linked onward, so
   * every surface was two taps deep and there was no way to tell where you were. A tab bar is what turns
   * a set of screens into an app — and it is the thing a rep uses one-handed on a roof.
   *
   * Tabs are filtered by the SAME policy that guards the route groups, so a role never sees a tab that
   * would bounce it back to the dashboard. Enforcement stays in the group layouts; this is the courtesy
   * half, exactly as the web sidebar is arranged.
   */
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.brandRed,
        tabBarInactiveTintColor: theme.color.textMuted,
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

function Restoring() {
  return (
    <View style={[formStyles.safe, formStyles.centre]}>
      <ActivityIndicator color={theme.color.brandRed} />
    </View>
  );
}
