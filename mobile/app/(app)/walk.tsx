/**
 * The AI walk screen — what an estimator looks at while walking a job site in Meta Ray-Ban
 * glasses, talking through the scope for 10-30 minutes.
 *
 * The estimator is outdoors, often gloved, holding the phone one-handed, and talking the whole
 * time. CAPTURE is the only control they touch while walking, so it dominates the screen; every
 * other control (especially End walk) is deliberately smaller and harder to hit. This file holds
 * NO lifecycle logic — it renders `walk.state` from `useWalk` and calls `start` / `capture` /
 * `end`. All the rules about when those are legal live in useWalk.ts and session.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { theme } from "../../src/theme/theme";
import { apiFetch } from "../../src/api/client";
import type { Fetcher } from "../../src/api/endpoints";
import { useAuth } from "../../src/auth/AuthContext";
import { useWalk } from "../../src/walkthrough/useWalk";
import { isAudioTruncated, isVideoTruncated, isWalkActive } from "../../src/walkthrough/session";
import { deriveWalkSiteLabel, deriveWalkTitle } from "../../src/walkthrough/walk-meta";
import { walkOwnerKey } from "../../src/walkthrough/owner-key";
import { drainWalkQueue, enqueueWalk, type WalkQueueMeta } from "../../src/walkthrough/upload";
import { walkthroughUploadClient } from "../../src/walkthrough/upload-client";
import { registerWalkUploadBackgroundTask } from "../../src/walkthrough/upload-background-task";

// Distinct from upload-queue's tag so the two features' keep-awake locks never interact —
// each activates and releases its own.
const KEEP_AWAKE_TAG = "trockcam-walk";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function WalkScreen() {
  // Same param-reading shape as capture.tsx, so a link into this screen matches the one already
  // proven to attach a capture to the right deal. propertyAddress rides along too — capture.tsx
  // only forwards it when its OWN dealId param matches the selected target (see detailParamsFor
  // there), same rule this screen inherits by construction.
  const params = useLocalSearchParams<{
    dealId?: string;
    targetName?: string;
    projectId?: string;
    propertyAddress?: string;
  }>();
  const router = useRouter();

  const dealId = typeof params.dealId === "string" ? params.dealId : "";
  const projectId = typeof params.projectId === "string" && params.projectId ? params.projectId : null;
  const targetName = typeof params.targetName === "string" && params.targetName ? params.targetName : "this project";
  const propertyAddress = typeof params.propertyAddress === "string" ? params.propertyAddress : null;

  const {
    walk,
    error,
    walkId,
    start,
    capture,
    end,
    reset,
    stillCount,
    bridgeAvailable,
    captureEnabled,
    atCaptureLimit,
  } = useWalk(dealId, projectId);

  // Identity for the upload queue: user + ACTIVE OFFICE, same resolution rule (activeOfficeId ??
  // primary office) as capture.tsx's own queue — and the SAME rule the background drain task uses,
  // so a walk enqueued here is a walk the background task can actually find.
  const { user, activeOfficeId, token, signOut } = useAuth();
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = walkOwnerKey(user?.id, resolvedOfficeId);
  const queueFetcher = useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, { ...opts, token: token ?? undefined, officeId: resolvedOfficeId, onUnauthorized: () => void signOut() }),
    [token, resolvedOfficeId, signOut],
  );

  // Best-effort: schedule the background drain once signed in, so a walk still ships if the app is
  // killed/backgrounded before the foreground drain below finishes. Registration itself is
  // idempotent (BackgroundTask.registerTaskAsync no-ops if already registered), so re-running this
  // on every mount of this screen is harmless.
  useEffect(() => {
    if (!ownerKey) return;
    void registerWalkUploadBackgroundTask();
  }, [ownerKey]);

  // Enqueue the walk the MOMENT it reaches a terminal state — complete OR failed. A failed walk that
  // captured artifacts is still a site visit that happened (session.ts's reducer keeps everything
  // captured before the failure on purpose); enqueueWalk/toQueuedWalk already never filter by
  // walk.state, so this effect must not add a filter here either. Owner decision: auto-upload, no
  // review gate — the estimator is free the moment the walk ends, so this never awaits anything the
  // UI is blocked on. enqueuedWalkIdRef guards against double-enqueueing the SAME walk across
  // re-renders (enqueueWalk itself is also idempotent per walkId, so this is a belt-and-suspenders
  // cheap-write avoidance, not a correctness requirement).
  const enqueuedWalkIdRef = useRef<string | null>(null);

  // The target the ACTIVE walk was started against, frozen at the moment it started.
  //
  // useWalk preserves an in-flight walk (and its dealId) when the route params change mid-recording
  // — session.ts's reset guard refuses to discard a live site visit. But `targetName` and
  // `propertyAddress` are pure route params with no reducer holding them, so reading them at
  // enqueue time filed the preserved walk against the ORIGINAL deal while labelling it with the
  // NEWLY selected deal's name and address. Half-wrong metadata is worse than wholly wrong: the
  // record looks internally consistent and confidently names the wrong job site.
  //
  // Keyed by walkId and only trusted on a match, so it is self-invalidating — the next walk mints a
  // fresh id (useWalk's newWalkId) and this is simply overwritten. Nothing has to remember to clear
  // it, which is the failure mode the enqueuedWalkIdRef comment above warns about.
  const startedTargetRef = useRef<{
    walkId: string;
    targetName: string;
    propertyAddress: string | null;
  } | null>(null);
  useEffect(() => {
    if (!walkId || !isWalkActive(walk.state)) return;
    // First active render for THIS walk wins. Later renders re-run this effect (targetName is a
    // dep), and the id match is what stops a mid-walk param change from overwriting the snapshot.
    if (startedTargetRef.current?.walkId === walkId) return;
    startedTargetRef.current = { walkId, targetName, propertyAddress };
  }, [walk.state, walkId, targetName, propertyAddress]);

  // This screen is a hidden `Tabs.Screen` — expo-router never unmounts it on navigation, only
  // blurs it — so returning here after a walk finished (for THIS deal or a different one) would
  // otherwise find `walk` stuck in "complete"/"failed" forever: session.ts's TERMINAL guard
  // absorbs every further event on purpose, but that's for a late native callback, not for the
  // estimator trying to start a genuinely new walk. Only reset a TERMINAL walk — resetting one
  // that's actually recording would silently discard an in-progress site visit if focus is lost
  // and regained mid-walk (e.g. a brief detour to another screen); useWalk's own reset() also
  // refuses that case now, but the intent here is to never even ask. enqueuedWalkIdRef is cleared
  // in lockstep: a stale value here wouldn't, by itself, block the NEXT walk (every walkId is
  // freshly random — see newWalkId() in useWalk.ts), but leaving a previous walk's id sitting in
  // a guard meant for THIS walk is exactly the kind of partial reset that invites a future bug.
  //
  // The callback handed to useFocusEffect must have a STABLE identity — read walk.state/reset
  // through refs, not directly, and depend on NEITHER. Expo Router re-runs this effect immediately
  // whenever the route is already focused and the callback's identity changes (the same "adjust on
  // prop change" mechanics as a plain useEffect), which used to be exactly how this fired: the
  // instant a walk reached "complete"/"failed" WHILE this screen was already the focused route
  // (this is a hidden tab — no blur/refocus ever has to happen), `[walk.state, reset]` changing
  // handed useCallback a new reference, and Router ran it right then — clearing the completion
  // summary (or fatal-error diagnostic) the same instant it appeared, before the estimator could
  // ever read it. Refs make the callback's identity constant across renders, so this now only
  // fires on a genuine focus transition (initial mount, or an actual blur-then-refocus) — the
  // completion summary now survives until the estimator actually navigates away and back.
  const walkStateForFocusRef = useRef(walk.state);
  walkStateForFocusRef.current = walk.state;
  const resetForFocusRef = useRef(reset);
  resetForFocusRef.current = reset;

  useFocusEffect(
    useCallback(() => {
      const state = walkStateForFocusRef.current;
      if (state === "complete" || state === "failed") {
        resetForFocusRef.current();
        enqueuedWalkIdRef.current = null;
      }
    }, []),
  );

  useEffect(() => {
    if (walk.state !== "complete" && walk.state !== "failed") return;
    if (!walkId || !ownerKey) return;
    if (enqueuedWalkIdRef.current === walkId) return;
    enqueuedWalkIdRef.current = walkId;
    // The snapshot for THIS walk, or the live params when there is none — a walk that somehow
    // reached a terminal state without ever being active has no earlier truth to prefer.
    const startedTarget =
      startedTargetRef.current?.walkId === walkId ? startedTargetRef.current : null;
    const walkTargetName = startedTarget?.targetName ?? targetName;
    const walkPropertyAddress = startedTarget ? startedTarget.propertyAddress : propertyAddress;
    // The marker goes INTO deriveWalkTitle's target name rather than onto its result: that function
    // clamps the finished title to the server's MAX_TITLE_CHARS, so appending afterwards would push
    // an already-maximal title past the limit and 400 the completion call — after every artifact is
    // in R2. Carried at all because the office is the other party that needs to know: a walk filed
    // as a normal 20-minute visit that turns out to hold five seconds of footage is exactly the
    // surprise the completion screen's notice exists to prevent, and the screen is gone by then.
    // Both transports get named, in one marker, because the title is one string and the office
    // needs to know WHICH half is thin: a walk missing its footage can still be scoped from the
    // narration, a walk missing its narration usually cannot be scoped at all. The video-only
    // wording is unchanged from what the office already reads.
    const cutShort = [
      isVideoTruncated(walk.videoCoverage) ? "video" : null,
      isAudioTruncated(walk.audioCoverage) ? "audio" : null,
    ].filter((part): part is string => part !== null);
    const titleTarget = cutShort.length
      ? `${walkTargetName} (${cutShort.join(" and ")} cut short)`
      : walkTargetName;
    const meta: WalkQueueMeta = {
      title: deriveWalkTitle(titleTarget, walk.startedAt ?? walk.endedAt ?? Date.now()),
      siteLabel: deriveWalkSiteLabel(walkPropertyAddress),
    };
    void enqueueWalk(ownerKey, walkId, walk, meta)
      .then((queued) => {
        // null = nothing to enqueue (not yet terminal, or terminal with zero captured artifacts —
        // e.g. failed before anything was recorded). Only kick a drain when there is something to
        // drain; the background task above still covers the case where this foreground kick itself
        // gets interrupted.
        if (queued) void drainWalkQueue(ownerKey, queueFetcher, walkthroughUploadClient).catch(() => undefined);
      })
      .catch(() => {
        // Best-effort: a failed enqueue here (e.g. storage full) is not surfaced to the estimator —
        // per the owner decision there is no review gate to surface it INTO. The walk's artifacts
        // remain on disk (never deleted before a successful completion call — see upload.ts), so
        // nothing is lost; a future resume of this screen (or an app-level recovery pass, not yet
        // built) is the retry path. Not silently losing evidence matters more here than surfacing a
        // banner the estimator has already walked away from.
        enqueuedWalkIdRef.current = null;
      });
  }, [walk, walkId, ownerKey, targetName, propertyAddress, queueFetcher]);

  // Local UI-only state: whether the harder-to-hit End walk control is asking for confirmation.
  // Not lifecycle — nothing here decides whether ending is ALLOWED, only how many taps it takes.
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  useEffect(() => {
    // A fresh "recording" state (a new walk started) should never inherit a confirm prompt left
    // over from a previous walk on this same mounted screen.
    if (walk.state !== "recording") setConfirmingEnd(false);
  }, [walk.state]);

  // Elapsed timer, ticking once a second from walk.startedAt while recording.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (walk.state !== "recording") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [walk.state]);

  // Keep the screen awake only while a walk is actually recording — a 20-minute walk with no
  // touches would otherwise let iOS sleep the screen mid-walk. Released the moment recording
  // stops, for any reason (ended, or a native failure), so nothing holds the lock past its use.
  const keptAwakeRef = useRef(false);
  useEffect(() => {
    if (walk.state === "recording") {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG)
        .then(() => {
          keptAwakeRef.current = true;
        })
        .catch(() => {
          // Best-effort, same as upload-queue's drain lock — a walk still records without it.
        });
      return () => {
        if (keptAwakeRef.current) {
          keptAwakeRef.current = false;
          void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
        }
      };
    }
    return undefined;
  }, [walk.state]);

  // The build predates the native recorder. No Start button can work, so none is shown — a
  // disabled one would invite exactly the silent-tap confusion requirement 3 exists to prevent.
  if (!bridgeAvailable) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.missingTitle}>Walk recorder unavailable</Text>
          <Text style={styles.missingBody}>
            This build predates the AI walk recorder. Rebuild the dev client to enable it.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const elapsedMs = walk.startedAt !== null ? Math.max(0, now - walk.startedAt) : 0;
  // Non-null exactly when there is something to warn about, so the summary below reads the numbers
  // without re-testing the threshold (session.ts's isVideoTruncated owns it) or asserting past null.
  const shortVideo = isVideoTruncated(walk.videoCoverage) ? walk.videoCoverage : null;
  const shortAudio = isAudioTruncated(walk.audioCoverage) ? walk.audioCoverage : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.screen}>
        {/* Verbatim, whenever present, regardless of state below — native's rejection text (e.g.
            `walk_no_hfp: RB Meta 014K`) names the input device it would have recorded from, and
            that is the entire diagnostic value. No wrapping, no prettifying, no truncation. */}
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {walk.state === "idle" || walk.state === "starting" ? (
          <View style={styles.centered}>
            <Text style={styles.aboutToLabel}>About to record</Text>
            <Text style={styles.aboutToTarget} numberOfLines={2}>
              {targetName}
            </Text>
            <Pressable
              onPress={() => void start()}
              disabled={walk.state === "starting"}
              accessibilityRole="button"
              accessibilityLabel="Start walk"
              accessibilityState={{ disabled: walk.state === "starting" }}
              style={({ pressed }) => [
                styles.startButton,
                walk.state === "starting" && styles.startButtonBusy,
                pressed && walk.state !== "starting" && styles.pressed,
              ]}
            >
              <Text style={styles.startButtonText}>
                {walk.state === "starting" ? "Starting…" : "Start walk"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {walk.state === "recording" ? (
          <View style={styles.recordingLayout}>
            <View style={styles.topRow}>
              <View style={styles.recordingDot} />
              <Text style={styles.timer}>{formatElapsed(elapsedMs)}</Text>
            </View>

            <Text style={styles.stillCount}>
              {stillCount} still{stillCount === 1 ? "" : "s"} captured
            </Text>
            {/* CAPTURE goes dark not just while not-recording but also at the server's per-walk
                artifact cap (session.ts's canCaptureMore) — say so explicitly, so a disabled
                button this far into a walk reads as "you're at the limit," not as broken. */}
            {atCaptureLimit ? (
              <Text style={styles.captureLimitNotice}>
                Maximum captures reached for this walk — end walk to upload what you have.
              </Text>
            ) : null}

            {/* The one control this screen is built around: huge, centered, impossible to miss
                even gloved and one-handed. Disabled — not merely unresponsive — the moment
                captureEnabled goes false (not recording, OR the artifact cap above), so a tap can
                never be silently swallowed. */}
            <View style={styles.captureWrap}>
              <Pressable
                onPress={() => void capture()}
                disabled={!captureEnabled}
                accessibilityRole="button"
                accessibilityLabel="Capture"
                accessibilityState={{ disabled: !captureEnabled }}
                style={({ pressed }) => [
                  styles.captureButton,
                  !captureEnabled && styles.captureButtonDisabled,
                  pressed && captureEnabled && styles.pressed,
                ]}
              >
                <View style={styles.captureButtonInner} />
              </Pressable>
              <Text style={styles.captureLabel}>CAPTURE</Text>
            </View>

            {/* Deliberately smaller and lower-contrast than CAPTURE, and gated behind a second
                tap — ending 20 minutes of walking by accident loses the whole site visit. */}
            <View style={styles.endWrap}>
              {confirmingEnd ? (
                <View style={styles.endConfirmRow}>
                  <Pressable
                    onPress={() => setConfirmingEnd(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Keep walking"
                    style={({ pressed }) => [styles.endConfirmCancel, pressed && styles.pressed]}
                  >
                    <Text style={styles.endConfirmCancelText}>Keep walking</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void end()}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm end walk"
                    style={({ pressed }) => [styles.endConfirmYes, pressed && styles.pressed]}
                  >
                    <Text style={styles.endConfirmYesText}>Yes, end walk</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setConfirmingEnd(true)}
                  accessibilityRole="button"
                  accessibilityLabel="End walk"
                  style={({ pressed }) => [styles.endButton, pressed && styles.pressed]}
                >
                  <Text style={styles.endButtonText}>End walk</Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : null}

        {walk.state === "finalizing" ? (
          <View style={styles.centered}>
            <Text style={styles.finalizingTitle}>Saving walk…</Text>
            <Text style={styles.finalizingBody}>Hold on while the recording is finalized.</Text>
          </View>
        ) : null}

        {walk.state === "complete" ? (
          <View style={styles.centered}>
            <Text style={styles.summaryTitle}>Walk complete</Text>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryValue}>
                {walk.durationMs !== null ? formatElapsed(walk.durationMs) : "—"}
              </Text>
              <Text style={styles.summaryCaption}>duration</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryValue}>{stillCount}</Text>
              <Text style={styles.summaryCaption}>still{stillCount === 1 ? "" : "s"} captured</Text>
            </View>
            {/* The whole point of measuring coverage. A walk whose glasses went quiet finalizes as
                a perfectly valid file, so without this the estimator walks away from the site
                believing they have twenty minutes of footage — and finds out weeks later, from a
                scope they can no longer re-walk. Said in minutes:seconds, not percentages, because
                the only question worth answering here is "do I need to walk it again?". Never a
                failure screen: the walk really did complete, the stills are fine, and the footage
                that does exist is still uploading. */}
            {shortVideo ? (
              <View style={styles.mediaShortNotice}>
                <Text style={styles.mediaShortTitle}>Video is short</Text>
                <Text style={styles.mediaShortBody}>
                  Only about {formatElapsed(shortVideo.videoMs)} of this{" "}
                  {formatElapsed(shortVideo.walkMs)} walk has video — roughly{" "}
                  {formatElapsed(shortVideo.shortfallMs)} is missing because the glasses stopped
                  sending.{" "}
                  {/* The reassurance is dropped when it would be false — the audio notice below is
                      about to say the opposite, and a screen that contradicts itself is a screen
                      the estimator stops trusting. */}
                  {shortAudio ? "Your stills are unaffected" : "Your stills and the audio are unaffected"},
                  and everything captured is still uploading.
                </Text>
              </View>
            ) : null}
            {/* The costlier half. Video going short loses pictures; narration going short loses the
                scope itself, because the spoken walkthrough is what the estimate is written from —
                and unlike the glasses, the phone microphone never stops sending, so this can only
                ever mean the writer refused audio mid-walk. Same register and same colour as the
                video notice: still not a failure screen, still uploading, but this is the one worth
                turning around for while the estimator is standing on the site. */}
            {shortAudio ? (
              <View style={styles.mediaShortNotice}>
                <Text style={styles.mediaShortTitle}>Narration is short</Text>
                <Text style={styles.mediaShortBody}>
                  Only about {formatElapsed(shortAudio.audioMs)} of this{" "}
                  {formatElapsed(shortAudio.walkMs)} walk has audio — roughly{" "}
                  {formatElapsed(shortAudio.shortfallMs)} is missing. The scope is written from what
                  you say, so if you are still on site it is worth walking the missing part again.
                  Everything captured is still uploading either way.
                </Text>
              </View>
            ) : null}
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Done"
              style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}
            >
              <Text style={styles.doneButtonText}>Done</Text>
            </Pressable>
          </View>
        ) : null}

        {walk.state === "failed" ? (
          <View style={styles.centered}>
            <Text style={styles.failedTitle}>Walk failed</Text>
            {/* walk.error is the same verbatim native/reducer text as the banner above — shown
                again here, large, because this is the terminal state and the banner alone could
                scroll out of a gloved, hurried glance. */}
            <Text style={styles.failedBody}>{walk.error}</Text>
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Done"
              style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}
            >
              <Text style={styles.doneButtonText}>Done</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.brandBlack },
  screen: { flex: 1, backgroundColor: theme.color.brandBlack },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.space.xl,
  },

  errorBanner: {
    backgroundColor: theme.color.danger,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  errorText: {
    color: theme.color.textInverse,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: theme.font.semibold,
  },

  missingTitle: {
    color: theme.color.textInverse,
    fontSize: 19,
    fontFamily: theme.font.bold,
    marginBottom: theme.space.sm,
    textAlign: "center",
  },
  missingBody: {
    color: theme.color.border,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },

  aboutToLabel: {
    color: theme.color.border,
    fontSize: 14,
    fontFamily: theme.font.medium,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: theme.space.sm,
  },
  aboutToTarget: {
    color: theme.color.textInverse,
    fontSize: 26,
    fontFamily: theme.font.bold,
    textAlign: "center",
    marginBottom: theme.space.xxl,
  },
  startButton: {
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.space.xl,
    paddingHorizontal: theme.space.xxl * 2,
    minWidth: 260,
    alignItems: "center",
  },
  startButtonBusy: { opacity: 0.7 },
  startButtonText: {
    color: theme.color.textInverse,
    fontSize: 22,
    fontFamily: theme.font.bold,
  },

  recordingLayout: {
    flex: 1,
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.space.xl,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    marginTop: theme.space.md,
  },
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.color.brandRed,
  },
  timer: {
    color: theme.color.textInverse,
    fontSize: 34,
    fontFamily: theme.font.bold,
    fontVariant: ["tabular-nums"],
  },
  stillCount: {
    color: theme.color.border,
    fontSize: 16,
    fontFamily: theme.font.medium,
  },
  captureLimitNotice: {
    color: theme.color.warning,
    fontSize: 13,
    fontFamily: theme.font.medium,
    textAlign: "center",
    marginTop: theme.space.xs,
    paddingHorizontal: theme.space.lg,
  },

  // The dominant control on the whole screen: large enough to hit reliably one-handed, gloved,
  // without looking — it fills most of the width so a rough tap anywhere in the lower-middle of
  // the screen still lands.
  captureWrap: { alignItems: "center", gap: theme.space.md },
  captureButton: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: theme.color.brandRed,
    borderWidth: 8,
    borderColor: theme.color.textInverse,
    alignItems: "center",
    justifyContent: "center",
  },
  captureButtonDisabled: {
    backgroundColor: theme.color.textMuted,
    borderColor: theme.color.border,
  },
  captureButtonInner: {
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: theme.color.textInverse,
  },
  captureLabel: {
    color: theme.color.textInverse,
    fontSize: 18,
    fontFamily: theme.font.bold,
    letterSpacing: 2,
  },

  // Everything below is intentionally smaller, lower-contrast, and one extra tap away from
  // CAPTURE — the opposite design goal of the button above.
  endWrap: { minHeight: 64, justifyContent: "flex-end", alignItems: "center" },
  endButton: {
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.lg,
  },
  endButtonText: {
    color: theme.color.border,
    fontSize: 14,
    fontFamily: theme.font.medium,
  },
  endConfirmRow: {
    flexDirection: "row",
    gap: theme.space.md,
    alignItems: "center",
  },
  endConfirmCancel: {
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  endConfirmCancelText: {
    color: theme.color.textInverse,
    fontSize: 14,
    fontFamily: theme.font.semibold,
  },
  endConfirmYes: {
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.danger,
  },
  endConfirmYesText: {
    color: theme.color.textInverse,
    fontSize: 14,
    fontFamily: theme.font.semibold,
  },

  finalizingTitle: {
    color: theme.color.textInverse,
    fontSize: 20,
    fontFamily: theme.font.bold,
    marginBottom: theme.space.sm,
  },
  finalizingBody: {
    color: theme.color.border,
    fontSize: 15,
    textAlign: "center",
  },

  summaryTitle: {
    color: theme.color.textInverse,
    fontSize: 24,
    fontFamily: theme.font.bold,
    marginBottom: theme.space.xl,
  },
  summaryRow: { alignItems: "center", marginBottom: theme.space.lg },
  summaryValue: {
    color: theme.color.textInverse,
    fontSize: 40,
    fontFamily: theme.font.bold,
    fontVariant: ["tabular-nums"],
  },
  summaryCaption: {
    color: theme.color.border,
    fontSize: 14,
    fontFamily: theme.font.medium,
  },
  // Warning, not danger: nothing failed, and dressing this in the red the "Walk failed" screen uses
  // would tell the estimator to redo a walk whose remaining artifacts are perfectly good. Shared by
  // the video and narration notices — one shortfall reads differently from two, and giving them
  // separate styling would imply a difference in severity that does not exist.
  mediaShortNotice: {
    borderWidth: 1,
    borderColor: theme.color.warning,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    paddingHorizontal: theme.space.lg,
    marginTop: theme.space.sm,
    maxWidth: 380,
  },
  mediaShortTitle: {
    color: theme.color.warning,
    fontSize: 16,
    fontFamily: theme.font.bold,
    marginBottom: theme.space.xs,
    textAlign: "center",
  },
  mediaShortBody: {
    color: theme.color.textInverse,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    fontFamily: theme.font.body,
  },
  doneButton: {
    marginTop: theme.space.xl,
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.space.lg,
    paddingHorizontal: theme.space.xxl * 2,
  },
  doneButtonText: {
    color: theme.color.textInverse,
    fontSize: 18,
    fontFamily: theme.font.bold,
  },

  failedTitle: {
    color: theme.color.brandRed,
    fontSize: 22,
    fontFamily: theme.font.bold,
    marginBottom: theme.space.md,
  },
  failedBody: {
    color: theme.color.textInverse,
    fontSize: 16,
    lineHeight: 22,
    textAlign: "center",
    fontFamily: theme.font.body,
  },

  pressed: { opacity: 0.8 },
});
