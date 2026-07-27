import React from "react";
import { Redirect, Stack } from "expo-router";
import { useAuth } from "../../src/auth/AuthContext";

/**
 * Authenticated shell. The tab bar arrives with the feature screens in later PRs; this PR ships the
 * auth spine and one landing screen, so a Stack is enough and avoids a tab bar with a single tab.
 */
export default function AppLayout() {
  const { session, gate } = useAuth();

  if (session === undefined) return null;
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
  if (gate === "checking") return null;

  // Enforced HERE, not only on the index route: index is just the launch redirect, and a deep link or a
  // restored navigation state can mount a screen inside this group without ever passing through it. A
  // gate that only guards the front door is not a gate.
  if (session.user.requiresOnboarding) return <Redirect href="/onboarding-required" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
