import React from "react";
import { Redirect, Tabs, useGlobalSearchParams, usePathname } from "expo-router";
import { ActivityIndicator, AppState, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { buildLoginReturnTo } from "../../src/navigation/return-to";
import { theme } from "../../src/theme/theme";
import { useWalkQueueSession } from "../../src/walkthrough/use-queue-session";
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
  const { ready, token } = useAuth();

  // Office resolution and the retired-session 401 guard both live in the shared hook, so this
  // shell, walk.tsx, profile.tsx and the background drain task cannot drift apart on either. See
  // use-queue-session.ts for why each of those rules exists.
  const { ownerKey, queueFetcher } = useWalkQueueSession();

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
      // keep is the authority to end a session: useWalkQueueSession retires it on teardown.
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
      {/* Renamed from "Scorecard" when the weekly client report joined the two scorecards under one
          roof. The tab now points at a hub; the scorecard screens themselves are unchanged and stay
          where they were (see the hidden `scorecards` registration below). */}
      <Tabs.Screen
        name="reports"
        options={{ title: "Reports", tabBarIcon: ({ color }) => <TabIcon name="clipboard-outline" color={color} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: "Profile", tabBarIcon: ({ color }) => <TabIcon name="person-outline" color={color} /> }}
      />
      {/* The scorecard screens keep their routes so every in-progress local draft and every deep link
          (`/scorecards/<draftId>`, the corrective-action links in outbound email) still resolves — they
          are simply entered from the Reports hub now instead of owning a tab. Same auto-registration
          trap as `dev-wearables`: without href: null this ships as a fifth tab beside its own hub. */}
      <Tabs.Screen name="scorecards" options={{ href: null }} />
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
