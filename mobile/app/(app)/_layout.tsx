import React from "react";
import { Redirect, Tabs, useGlobalSearchParams, usePathname } from "expo-router";
import { ActivityIndicator, AppState, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../src/auth/AuthContext";
import { buildLoginReturnTo } from "../../src/navigation/return-to";
import { theme } from "../../src/theme/theme";
import { useWalkQueueSession } from "../../src/walkthrough/use-queue-session";
import { usePhotoQueueSession } from "../../src/capture/use-photo-queue-session";
import {
  drainUploadQueue,
  getQueuedCount,
  getQueuedUploads,
  getSchedulableCount,
  subscribeToQueueChanges,
} from "../../src/capture/upload-queue";
import { drainBackgroundOwnerQueues } from "../../src/capture/upload-background-core";
import { registerUploadBackgroundTask } from "../../src/capture/upload-background-task";
import { listScorecardDraftOwners } from "../../src/scorecards/draft-store";
import { qk } from "../../src/query/keys";
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
  const { ready, token, user } = useAuth();

  // Office resolution and the retired-session 401 guard both live in the shared hook, so this
  // shell, walk.tsx, profile.tsx and the background drain task cannot drift apart on either. See
  // use-queue-session.ts for why each of those rules exists.
  const { ownerKey, queueFetcher } = useWalkQueueSession();

  // The PHOTO queue's own identity + fetcher. Separate hook, and specifically NOT capture.tsx's
  // fetcher: that one carries onUnauthorized -> signOut, which is safe on a screen the user chose to
  // open and catastrophic here. See use-photo-queue-session.ts rule 2.
  const { ownerKey: photoOwnerKey, resolvedOfficeId, queueFetcher: photoQueueFetcher } = usePhotoQueueSession();
  const [queuedPhotos, setQueuedPhotos] = React.useState(0);
  const queryClient = useQueryClient();

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

  /**
   * The same resume, for the PHOTO queue. It is the walk effect above applied to the other queue, and
   * the reason it did not already exist is the whole of the reported bug.
   *
   * Photo captures drained from exactly two places: the Capture screen, and the opportunistic iOS
   * background window (which upload-background-task.ts's own header calls a long-tail safety net, not a
   * mechanism). Every other screen — including the project gallery a superintendent stares at while
   * asking where yesterday's photos went — could not move the queue at all. Measured on production: of
   * 267 photos captured on Sep 10, ZERO reached the server that day; they arrived the next morning.
   *
   * Registering the background task here too (it was only registered from Capture and the Reports hub)
   * means a crew that photographs from a project screen and never opens the Capture tab still gets the
   * OS-granted windows. Both calls are idempotent and fully guarded.
   *
   * Ordering note: this runs alongside the walk drain above, not after it. The two queues are
   * independent, each drain self-serialises on its own module lock, and neither should wait on the other
   * — a multi-GB walk video must not hold up a day of photos, which is exactly the starvation this
   * feature exists to remove.
   */
  React.useEffect(() => {
    // uploadOwnerKey returns "" without a signed-in user, so a non-empty key already implies one — but
    // name it explicitly rather than asserting, since listScorecardDraftOwners keys its registry on it
    // and a wrong/absent id would enumerate someone else's namespaces or none at all.
    const userId = user?.id;
    if (!token || !photoOwnerKey || !userId) return;
    let active = true;
    void registerUploadBackgroundTask();

    const refreshBadge = async () => {
      const queued = await getQueuedCount(photoOwnerKey).catch(() => 0);
      if (active) setQueuedPhotos(queued);
    };

    /**
     * Every namespace this device might hold photos under, not just the active office.
     *
     * Scorecard drafts deliberately persist their evidence under the OWNING office's key so an edit
     * survives an office switch or the submitter being re-homed. Draining only the active key would leave
     * that evidence dependent on an opportunistic OS window — the same "queued, durable, and nothing is
     * scheduled to send it" state this effect exists to end, just one namespace over. The background task
     * already enumerates exactly this way; the foreground had no reason to be narrower.
     */
    const ownersToDrain = async () => {
      const fallback = { ownerKey: photoOwnerKey, officeId: resolvedOfficeId };
      try {
        return await listScorecardDraftOwners(userId, photoOwnerKey);
      } catch {
        return [fallback];
      }
    };

    const drainIfQueued = async () => {
      await refreshBadge();
      const owners = await ownersToDrain();
      if (!active) return;
      // Galleries to refresh = the deals that actually have photos waiting, read BEFORE the drain (the
      // rows are gone from the index afterwards). Mirrors what the Capture screen does with its own
      // drain: without it a mounted project gallery keeps rendering its cached, missing-photo list even
      // though the server now has the photos — useProjectPhotos does not poll, and React Query's
      // window-focus refetch is a no-op in React Native. That gallery is the screen the whole report
      // was filed about.
      const dealIds = new Set<string>();
      for (const owner of owners) {
        for (const item of await getQueuedUploads(owner.ownerKey).catch(() => [])) {
          const dealId = item.target?.dealId;
          if (dealId) dealIds.add(dealId);
        }
      }

      let shipped = 0;
      // Sequential, one namespace at a time (drainBackgroundOwnerQueues' own contract), so a corrupt or
      // failing office cannot starve the ones after it and the drains never race each other.
      await drainBackgroundOwnerQueues(owners, {
        getSchedulableCount,
        drainOwner: async (owner) => {
          const summary = await drainUploadQueue(owner.ownerKey, photoQueueFetcher);
          shipped += summary.succeeded;
        },
      }).catch(() => undefined);

      if (!active) return;
      if (shipped > 0) {
        for (const dealId of dealIds) {
          void queryClient.invalidateQueries({ queryKey: qk.projectPhotos(userId, dealId) });
        }
      }
      await refreshBadge();
    };
    const run = () => void drainIfQueued().catch(() => undefined);

    run();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") run();
    });
    // The badge has to track the QUEUE, not just this effect's own drains. A photo enqueued while the app
    // stays open fires neither mount nor foreground, so without this the count sat stale — and a badge
    // reading 0 while 40 photos wait answers "did they send?" wrongly, which is worse than no badge.
    const unsubscribe = subscribeToQueueChanges(() => void refreshBadge());
    return () => {
      // Only stops NEW drains after unmount; one already in flight is deliberately left to finish, since
      // abandoning an upload on a navigation change is the failure this effect exists to prevent.
      active = false;
      sub.remove();
      unsubscribe();
    };
  }, [token, photoOwnerKey, photoQueueFetcher, resolvedOfficeId, user, queryClient]);

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
      {/* The badge is the answer to "did my photos upload?", which until now the app could only be asked
          on the Capture screen — the one place a crew is NOT standing when they go looking for yesterday's
          photos in a project gallery. A queued count that is visible from every tab is the difference
          between "still sending, 40 to go" and a silence the user can only read as data loss, which is how
          this was reported. Undefined rather than 0 so the badge disappears when the queue is empty. */}
      <Tabs.Screen
        name="capture"
        options={{
          title: "Capture",
          tabBarIcon: ({ color }) => <TabIcon name="camera-outline" color={color} />,
          tabBarBadge: queuedPhotos > 0 ? queuedPhotos : undefined,
          tabBarBadgeStyle: { backgroundColor: theme.color.brandRed, fontFamily: theme.font.medium },
        }}
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
