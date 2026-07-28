import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/auth/AuthContext";
import { openLink } from "../src/lib/open-link";
import { theme } from "../src/theme/theme";

/**
 * The onboarding (migration cleanup) gate, mirroring the web app's OnboardingRequiredPage.
 *
 * This gate is CLIENT-ENFORCED on both surfaces. The server annotates the user with
 * `requiresOnboarding` (auth/service.ts:130, when pendingCleanupCount > 0) but does NOT block CRM
 * endpoints on it — so an app that ignores the flag does not get errors, it gets full access, and the
 * mandatory cleanup flow is simply skipped. Mobile has to reproduce the block or it becomes the way
 * around it.
 *
 * Unlike the web version this does NOT auto-redirect. The cleanup workspace is a separate web app; on a
 * phone, throwing the user into an external browser with no way back is worse than showing them what is
 * required and letting them choose — including choosing to sign out on a shared device.
 */
export default function OnboardingRequiredScreen() {
  const { session, gate, revalidate, signOut } = useAuth();
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function checkAgain() {
    setChecking(true);
    setLinkError(null);
    try {
      await revalidate();
    } catch {
      // revalidate() has no reachable rejection path today, but it is invoked as `void checkAgain()`,
      // so anything that starts throwing in there becomes an unhandled rejection with no user-visible
      // symptom on the one screen a blocked user is stuck reading. The gate === "stale" line below
      // covers the ordinary offline case; this covers the unexpected one.
      setLinkError("Couldn't check just now. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  /**
   * https only — plus http on loopback in development.
   *
   * `cleanupUrl` arrives from the server (cleanupAppUrl()) and is handed straight to the OS, so a
   * misconfigured or malformed value could open an arbitrary scheme rather than a web page. Nothing
   * suggests it is attacker-controlled today, but validating the one thing this button is for costs a
   * line, and "the server sent it" is not a property the OS checks.
   *
   * The loopback exception exists because the server's development default is `http://localhost:5175`
   * (auth/service.ts:60-65). A flat https-only rule nulled that out and removed the button entirely, so
   * the one flow this screen exists for could not be exercised locally at all — a rule strict enough to
   * block its own development setup. Gated on __DEV__ and on the host actually being loopback, so a
   * release build still refuses plain http, and a dev build still refuses http to anywhere else.
   */
  function safeCleanupUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol === "https:") return raw;
      // `[::1]` with the brackets: WHATWG URL keeps them in `hostname` for an IPv6 literal, so a plain
      // "::1" comparison never matches and a dev box on IPv6 loopback loses the button entirely.
      const isLoopback =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]";
      return __DEV__ && url.protocol === "http:" && isLoopback ? raw : null;
    } catch {
      return null;
    }
  }

  if (session === undefined) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      </SafeAreaView>
    );
  }

  if (!session) return <Redirect href="/login" />;
  // Cleared since this session was cached — nothing left to do here, and staying would trap the user.
  if (!session.user.requiresOnboarding) return <Redirect href="/(app)/dashboard" />;

  /**
   * A NEGATIVE count is the server's fail-closed sentinel, not a queue size.
   *
   * getUserOnboardingGateStatus returns { requiresOnboarding: true, onboardingPendingCount: -1 } when it
   * cannot query the gate at all (auth/service.ts:133-140). Passing that through rendered "-1 pending
   * items" on the one screen a blocked user is stuck reading — which reads as a bug in their account
   * rather than a temporary server problem, and gives them nothing to act on.
   */
  const rawPending = session.user.onboardingPendingCount;
  const pendingKnown = typeof rawPending === "number" && rawPending >= 0;
  const pending = pendingKnown ? rawPending : 0;
  const cleanupUrl = safeCleanupUrl(session.user.cleanupUrl);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        <Text style={styles.kicker}>Onboarding required</Text>
        <Text style={styles.title}>Finish cleanup before using the CRM</Text>
        <Text style={styles.copy}>
          {pendingKnown
            ? `Your migration cleanup queue has ${pending} pending item${pending === 1 ? "" : "s"}. ` +
              "Complete it in the cleanup workspace on a computer, then reopen this app."
            : "We couldn't check your cleanup queue just now, so access is held until we can. " +
              "Try again in a moment, or open the cleanup workspace on a computer."}
        </Text>

        {cleanupUrl ? (
          <Pressable
            testID="open-cleanup"
            onPress={() => void openLink(cleanupUrl, setLinkError)}
            accessibilityRole="button"
            style={styles.button}
          >
            <Text style={styles.buttonText}>Open cleanup workspace</Text>
          </Pressable>
        ) : null}

        {/* Cleanup happens in an EXTERNAL browser, so returning to the app does not remount the provider
            and the session keeps its stale requiresOnboarding: true. AuthContext now revalidates on every
            foreground, which covers the common path; this button is the explicit escape when that check
            is offline, still in flight, or the user simply wants to force it. Without either, finishing
            cleanup left the user stuck here until they force-quit or signed out. */}
        <Pressable
          testID="recheck-onboarding"
          onPress={() => void checkAgain()}
          disabled={checking || gate === "checking"}
          accessibilityRole="button"
          style={styles.secondary}
        >
          {checking ? (
            <ActivityIndicator color={theme.color.brandRed} />
          ) : (
            <Text style={styles.secondaryText}>I&apos;ve finished — check again</Text>
          )}
        </Pressable>

        {linkError ? (
          <Text testID="cleanup-link-error" style={styles.note}>
            {linkError}
          </Text>
        ) : null}

        {gate === "stale" ? (
          <Text style={styles.note}>Couldn&apos;t reach the server. Reconnect and check again.</Text>
        ) : null}

        {/* Shared devices again: without this, one account waiting on cleanup blocks everyone else. */}
        <Pressable
          testID="onboarding-sign-out"
          onPress={async () => {
            await signOut();
            router.replace("/login");
          }}
          accessibilityRole="button"
          style={styles.signOut}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, justifyContent: "center", padding: theme.space.xl, gap: theme.space.md },
  kicker: {
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: theme.color.redText,
  },
  title: { fontFamily: theme.font.bold, fontSize: 26, color: theme.color.inkNavy },
  copy: { fontFamily: theme.font.regular, fontSize: 15, lineHeight: 22, color: theme.color.textSecondary },
  button: {
    marginTop: theme.space.md,
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
  },
  buttonText: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textInverse },
  secondary: {
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
  },
  secondaryText: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.redText },
  note: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted, textAlign: "center" },
  signOut: { marginTop: theme.space.sm, alignItems: "center", paddingVertical: theme.space.md },
  signOutText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textSecondary },
});
