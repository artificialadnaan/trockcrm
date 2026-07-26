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

  return <Stack screenOptions={{ headerShown: false }} />;
}
