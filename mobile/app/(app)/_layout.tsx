import React from "react";
import { Redirect, Tabs, useGlobalSearchParams, usePathname } from "expo-router";
import { ActivityIndicator, AppState, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "../../src/api/client";
import type { Fetcher } from "../../src/api/endpoints";
import { useAuth } from "../../src/auth/AuthContext";
import { buildLoginReturnTo } from "../../src/navigation/return-to";
import { theme } from "../../src/theme/theme";
import { walkOwnerKey } from "../../src/walkthrough/owner-key";
import {
  drainWalkQueue,
  forgetRecoverableWalksAtStartup,
  getSchedulableWalkCount,
  scanRecoverableWalksAtStartup,
} from "../../src/walkthrough/upload";
import { walkthroughUploadClient } from "../../src/walkthrough/upload-client";

// Monochrome vector icons so the active tab icon inherits tabBarActiveTintColor
// (brand red) in lockstep with its label — the emoji glyphs never picked up the tint.
type IoniconName = React.ComponentProps<typeof Ionicons>["name"];
function TabIcon({ name, color }: { name: IoniconName; color: string }) {
  return <Ionicons name={name} size={23} color={color} />;
}

/** Authenticated tab shell (Projects / Capture / Profile) — replaces FieldLayout. */
export default function AppLayout() {
  const { ready, token, user, activeOfficeId, signOut } = useAuth();

  // Same office-resolution rule as walk.tsx, profile.tsx and the background drain task
  // (activeOfficeId ?? primary office) — all four MUST agree, or this would scan and drain a
  // manifest namespace no walk was ever written into. owner-key.ts is the single source of truth.
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = walkOwnerKey(user?.id, resolvedOfficeId);

  // Scan once for walk recordings that were interrupted before they could be queued — an app kill
  // mid-recording, or after native finalised but before the enqueue effect ran, leaves files under
  // Documents/walkthroughs/ that nothing else would ever look for.
  //
  // It runs HERE rather than on Profile because the scan is only trustworthy before anything could
  // be recording: an active walk has no manifest entry either (it is not enqueued until terminal),
  // so scanning mid-walk would report the live recording as orphaned. This layout mounts on entry
  // to the authenticated shell, before any walk screen can exist; Profile then subscribes to the
  // snapshot rather than re-scanning.
  //
  // The teardown is half of that, not tidiness. upload.ts remembers the answer, and a module
  // variable survives sign-out — the process is still running — so a second sign-in on this device
  // was served the FIRST session's snapshot and never scanned again. That defeated useWalk's
  // unmount finalize, whose entire purpose is to leave a walk interrupted by sign-out discoverable
  // at the next login: the directory existed and nothing ever looked. Forgetting on the way out
  // (rather than re-scanning on the way in) is what keeps the scan's own precondition intact —
  // teardown is the one moment that is both "this answer is stale" and "nothing can be recording".
  React.useEffect(() => {
    if (!token || !ownerKey) return;
    void scanRecoverableWalksAtStartup(ownerKey);
    return forgetRecoverableWalksAtStartup;
  }, [token, ownerKey]);

  /**
   * The session the queue fetcher below speaks for, as ONE object whose identity changes whenever
   * that session does — and which the effect underneath retires when this shell (or this token)
   * goes away.
   *
   * A drain deliberately outlives this shell: abandoning a multi-GB upload at sign-out is the
   * failure the resume effect exists to prevent, so the drain keeps running with the fetcher it was
   * handed. That fetcher holds THIS token and THIS signOut, and after a different user signs in
   * both are obsolete — the old token is revoked, so the abandoned drain's next API call 401s, and
   * an unguarded `onUnauthorized` would then clear the in-memory auth state and the persisted
   * session, signing out the user who just signed IN. `retired` scopes the sign-out to the session
   * generation that started the drain: a 401 on a live session still ends it (that token really is
   * dead), a 401 on a superseded one is only ever news about a token nobody is using anymore.
   */
  const queueSession = React.useMemo(
    () => ({ token, officeId: resolvedOfficeId, signOut, retired: false }),
    [token, resolvedOfficeId, signOut],
  );
  React.useEffect(() => {
    // Re-arm rather than assume: StrictMode and Fast Refresh run cleanup-then-effect against the
    // SAME object, and a session left retired by that would silently stop honouring real 401s.
    queueSession.retired = false;
    return () => {
      queueSession.retired = true;
    };
  }, [queueSession]);

  const queueFetcher = React.useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, {
        ...opts,
        token: queueSession.token ?? undefined,
        officeId: queueSession.officeId,
        onUnauthorized: () => {
          if (!queueSession.retired) void queueSession.signOut();
        },
      }),
    [queueSession],
  );

  /**
   * Resume whatever is ALREADY queued, both on entry to the authenticated shell and every time the
   * app comes back to the foreground.
   *
   * Without this, a manifest could only ever be drained by the one trigger that created it:
   * walk.tsx fires a drain when a walk reaches a terminal state. Kill the process mid-drain — an
   * OS memory kill, a crash, the user swiping the app away while a multi-GB video uploads — and
   * that trigger is gone for good. The recording stayed queued, correctly and durably, with nothing
   * in the foreground ever looking at it again; the background task is explicitly opportunistic
   * (see upload-background-task.ts's header — iOS may grant its window hours later or not at all),
   * so simply reopening the app could leave a perfectly schedulable site visit unsent indefinitely.
   *
   * The shell is the right owner: it is the one component every authenticated route mounts under,
   * it already resolves the owner key, and unlike walk.tsx it isn't tied to a single deal. The
   * AppState half matters more than the mount half in practice — this layout rarely remounts,
   * while "backgrounded mid-upload, then reopened" is the ordinary case.
   */
  React.useEffect(() => {
    if (!token || !ownerKey) return;
    let active = true;
    const drainIfQueued = async () => {
      // Cheap manifest read first, exactly as the background task gates itself: the overwhelmingly
      // common answer is zero, and drainWalkQueue would otherwise take the drain lock and
      // keep-awake on literally every foreground transition.
      if ((await getSchedulableWalkCount(ownerKey)) === 0 || !active) return;
      // No "is a drain already running?" check needed: drainWalkQueue coalesces a request made
      // during an active drain into a follow-up pass. That is exactly what should happen here —
      // a resume that lands mid-drain means the queue is worth re-reading, not ignoring.
      await drainWalkQueue(ownerKey, queueFetcher, walkthroughUploadClient);
    };
    const run = () => void drainIfQueued().catch(() => undefined);

    run();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") run();
    });
    return () => {
      // Only stops NEW drains from being started after unmount; a drain already in flight is
      // deliberately left to finish — abandoning an upload on a navigation change is the failure
      // this effect exists to prevent, not something to reintroduce. What that survivor must NOT
      // keep is the authority to end a session: queueSession's own effect retires it here too.
      active = false;
      sub.remove();
    };
  }, [token, ownerKey, queueFetcher]);

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
