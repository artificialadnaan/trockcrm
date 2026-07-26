import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "../../src/auth/AuthContext";

/**
 * Authenticated shell. The tab bar arrives with the feature screens in later PRs; this PR ships the
 * auth spine and one landing screen, so a Stack is enough and avoids a tab bar with a single tab.
 */
export default function AppLayout() {
  const { session } = useAuth();

  if (session === undefined) return null;
  if (!session) return <Redirect href="/login" />;
  if (session.user.mustChangePassword) return <Redirect href="/change-password" />;
  // Enforced HERE, not only on the index route: index is just the launch redirect, and a deep link or a
  // restored navigation state can mount a screen inside this group without ever passing through it. A
  // gate that only guards the front door is not a gate.
  if (session.user.requiresOnboarding) return <Redirect href="/onboarding-required" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
