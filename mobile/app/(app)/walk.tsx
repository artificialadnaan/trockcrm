/**
 * The AI walk screen — what an estimator looks at while walking a job site in Meta Ray-Ban
 * glasses, talking through the scope for 10-30 minutes.
 *
 * The estimator is outdoors, often gloved, holding the phone one-handed, and talking the whole
 * time. CAPTURE is the only control they touch while walking, so it dominates the screen; every
 * other control (especially End walk) is deliberately smaller and harder to hit. This file holds
 * NO lifecycle logic — it renders `walk.state` from `useWalk` and calls `start` / `capture` /
 * `end`. All the rules about when those are legal live in useWalk.ts and session.ts.
 *
 * READINESS is the one thing that does live here, and it is a different question from lifecycle:
 * whether to draw a Start button at all. Three preconditions answer it — no recorder in this build,
 * no deal to file the walk against, and no Meta camera authorization — and each is a refusal the
 * ESTIMATOR has to act on, so each states what is wrong in this screen's own words rather than
 * letting a tap fail somewhere they cannot see.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { errorMessage } from "../../src/lib/error-message";
import { theme } from "../../src/theme/theme";
import { useWalk } from "../../src/walkthrough/useWalk";
import { Wearables, isAvailable as wearablesBridgeAvailable } from "../../src/wearables/native";
import { describePairing, type Pairing } from "../../src/walkthrough/pairing";
import { isAudioTruncated, isVideoTruncated, isWalkActive, type Walk } from "../../src/walkthrough/session";
import { deriveWalkSiteLabel, deriveWalkTitle } from "../../src/walkthrough/walk-meta";
import { useWalkQueueSession } from "../../src/walkthrough/use-queue-session";
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

/**
 * Meta's camera authorization for THIS app — read as a `describePairing` verdict, plus the one
 * action that fixes it.
 *
 * It is a third permission, independent of Bluetooth pairing and of the phone's own camera and
 * microphone grants, and until now the only place that ever requested it was Profile's pairing row.
 * Nothing on the route an estimator actually walks — project → Capture → walk — goes through
 * Profile, so a fresh install with registered glasses reached this screen fully "paired" and still
 * could not open a DAT stream. `Recorder.startWalk` does not ask for it either (it asks for the
 * microphone and stops there), so the walk died at session/stream creation with a message about the
 * SDK that this screen had no way to translate.
 *
 * Reads `describePairing`'s verdict rather than `diagnosis.cameraPermission` directly, deliberately:
 * that function already decides what a raw permission string means, in what order, and it already
 * says the sentence Profile shows for the same problem. A second interpretation here is how the two
 * screens end up disagreeing about the same device.
 *
 * Two rules the rest of this file depends on:
 *
 *   - A check that never completed produces NO verdict, not a blocking one. `pairing` stays null
 *     and Start is offered exactly as before. Refusing a site visit because a diagnostic call threw
 *     would cost the estimator the walk over our own plumbing — native still has its own guards at
 *     the far end.
 *   - A check that FAILS after one succeeded keeps the earlier verdict rather than blanking it, the
 *     same way Profile's row never blanks on a refresh error. The grant control below stays on
 *     screen either way, so a stale "blocked" is never a dead end.
 */
function useCameraAuthorization(): {
  /** The `cameraBlocked` verdict, or null for every other status AND for "not known yet". */
  blocked: Pairing | null;
  requesting: boolean;
  /** What Meta said when a grant did not take. Verbatim — see the setter. */
  requestNotice: string | null;
  request: () => Promise<void>;
} {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    // Not the same bridge as `useWalk`'s: WearablesBridge is the SDK, WalkthroughRecorder is the
    // recorder. A build can have one and not the other, and with no SDK bridge there is nothing to
    // ask — describePairing would only ever answer "unavailable", which is the recorder's own
    // full-screen refusal below to make, not this gate's.
    if (!wearablesBridgeAvailable) return;
    try {
      const configureResult = await Wearables.configure();
      const status = await Wearables.status();
      const diagnosis = await Wearables.diagnose();
      const device = diagnosis.devices[0];
      const next = describePairing({
        bridgeAvailable: true,
        configured: configureResult.configured,
        registrationState: status.registrationState,
        deviceCount: status.deviceCount,
        deviceName: device?.name ?? null,
        linkState: device?.linkState ?? null,
        cameraPermission: diagnosis.cameraPermission,
      });
      if (mountedRef.current) setPairing(next);
    } catch {
      // Swallowed on purpose, and the previous verdict is left standing — see the doc above. There
      // is nowhere to report this to that would help: the estimator cannot act on "diagnose threw",
      // and the only thing that turns on this value is whether Start is offered.
    }
  }, []);

  useEffect(() => {
    void check();
    // Foreground, not focus. Whatever `requestPermission(.camera)` does — WearablesBridge.swift's
    // own comment says it bounces through the Meta AI app, Profile's says it resolves in process —
    // this listener is what makes a grant made ANYWHERE else (the Meta AI app, iOS Settings) show
    // up here without the estimator having to know to refresh. This screen is a hidden Tabs.Screen
    // that never unmounts on navigation, so a focus effect would miss the round trip entirely.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void check();
    });
    return () => sub.remove();
  }, [check]);

  const request = useCallback(async () => {
    setRequesting(true);
    setRequestNotice(null);
    try {
      const { status } = await Wearables.requestCameraPermission();
      // A request that resolves NOT-granted is the silent dead end: nothing threw, so there is no
      // error to show, and the re-check below simply reproduces the same gate. Meta's own answer is
      // the only information anyone has about why, so it is repeated verbatim — the same rule the
      // error banner at the top of this screen follows for native's rejection text.
      if (status !== "granted" && mountedRef.current) {
        setRequestNotice(
          `Meta answered "${status}" — camera access still isn't granted. Try again, or grant it ` +
            `for T-Rock Cam in the Meta AI app.`,
        );
      }
    } catch (error) {
      // Meta's own words, and only those — the "Error:" a stringified Error carries is not part of
      // what the SDK said, and this notice is shown precisely because the SDK's text is the only
      // information anyone has about why the grant did not take.
      if (mountedRef.current) setRequestNotice(errorMessage(error));
    } finally {
      if (mountedRef.current) setRequesting(false);
    }
    // Re-read regardless of outcome, so the gate reflects what the SDK actually did rather than
    // assuming the request took. Same reasoning as Profile's own grant handler.
    await check();
  }, [check]);

  return {
    // Only ever the one status. Every other verdict — unpaired, disconnected, unconfigured — is a
    // problem native reports at startWalk with text this screen shows verbatim, and gating on those
    // too would turn a transient reading (glasses asleep in a pocket for a second) into a refusal to
    // record a site visit. `cameraBlocked` is different: it cannot resolve itself, it cannot be
    // fixed by native, and the fix is one tap away right here.
    blocked: pairing?.status === "cameraBlocked" ? pairing : null,
    requesting,
    requestNotice,
    request,
  };
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

  // Identity for the upload queue: user + ACTIVE OFFICE, same resolution rule (activeOfficeId ??
  // primary office) as capture.tsx's own queue — and the SAME rule the background drain task uses,
  // so a walk enqueued here is a walk the background task can actually find.
  // This screen's drain outlives it: it fires the moment a walk goes terminal and keeps uploading
  // after the shell (and therefore this hidden tab) unmounts at sign-out, so its 401 handling has
  // to be scoped to the session that started it. See use-queue-session.ts.
  //
  // Resolved ABOVE useWalk, not below it: the recorder now stamps the walk's directory with this
  // identity before native writes a byte (see claimWalkDirForOwner), so useWalk needs it at start
  // rather than only at enqueue.
  const { ownerKey, queueFetcher } = useWalkQueueSession();

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
    videoSize,
    stoppedAtSizeLimit,
  } = useWalk(dealId, projectId, ownerKey);

  const {
    blocked: cameraBlocked,
    requesting: requestingCamera,
    requestNotice: cameraRequestNotice,
    request: requestCameraAccess,
  } = useCameraAuthorization();

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

  /**
   * EVERY finished walk the queue REFUSED this shell lifecycle, each kept until it is taken.
   *
   * Each entry carries its own copy of the recording and its metadata rather than pointing at the
   * render, because it has to outlive both: the focus effect just above resets a terminal walk the
   * moment this never-unmounting route is left and reopened, so `walk`/`walkId` are gone by the time
   * a hurried estimator gets back to the notice. That reset is what USED to be the whole story — the
   * failed enqueue cleared a ref, changed no state, and the walk quietly ceased to exist as far as
   * anything in the app was concerned, with the files still on disk and nobody told to go looking.
   *
   * A LIST rather than the single entry this started as, because the notice never gated Start —
   * deliberately: an estimator with a site to record must not be held hostage to a queue that is
   * refusing (the same trade the startup scan already refuses to make; see the "Rejected: gating
   * Start until the scan settles" reasoning). So the next walk goes ahead, and when ITS enqueue also
   * fails — which is the EXPECTED shape of this failure, not a corner case, since a full phone or a
   * broken manifest write does not repair itself between two walks — a single slot meant the second
   * refusal overwrote the first. The first recording was then unreachable for the rest of the
   * session: reset out of the screen, absent from the manifest, and invisible to the startup orphan
   * scan, which runs ONCE per shell lifecycle and had already run. Nothing else in the app would
   * have mentioned it again before sign-out or a process restart.
   *
   * Oldest first (append order), so the walk that has been waiting longest — the one closest to
   * being forgotten — is the one at the top rather than the one pushed off the bottom.
   */
  type UnqueuedWalk = {
    walkId: string;
    walk: Walk;
    meta: WalkQueueMeta;
    /** Whatever the queue threw, verbatim — the same rule the error banner follows. "No space left
     *  on device" is the only part of it the estimator can act on, and no wording of ours knows
     *  which failure this was. */
    message: string;
  };
  const [unqueuedWalks, setUnqueuedWalks] = useState<readonly UnqueuedWalk[]>([]);
  // Which walks have a retry in flight — per walkId, not one flag for the screen, or retrying the
  // older walk would grey out the newer one's button and read as if both were being handled.
  const [refilingWalkIds, setRefilingWalkIds] = useState<readonly string[]>([]);

  /**
   * Hand ONE finished walk to the queue — from the terminal-state effect below, and from the retry
   * the notice offers. Both go through here so a retry is the same filing, not a second path with
   * its own idea of what "queued" means.
   */
  /**
   * Put ONE refusal on screen, keyed by walkId — a retry that fails again is the SAME recording
   * refusing a second time, so it replaces its own entry (with the newer reason, which is often not
   * the first one's) rather than adding a duplicate row for a single walk.
   *
   * Extracted because there are now two ways to be refused and they must produce one row either way:
   * the queue throwing, and this screen declining to call the queue at all.
   */
  const noteRefusal = useCallback((refused: UnqueuedWalk) => {
    setUnqueuedWalks((current) => {
      const at = current.findIndex((entry) => entry.walkId === refused.walkId);
      if (at === -1) return [...current, refused];
      const next = current.slice();
      next[at] = refused;
      return next;
    });
  }, []);

  const fileWalk = useCallback(
    async (finishedWalkId: string, finishedWalk: Walk, meta: WalkQueueMeta) => {
      if (!ownerKey) {
        // Reachable from the RETRY button and only from there: the terminal-state effect below makes
        // this same check before it ever calls in, so its path is unaffected. A silent return here
        // left the retry setting a busy flag, clearing it, changing nothing, and leaving the previous
        // reason standing — the button reads as broken on the one surface that can still save the
        // recording. The sequence is not exotic: an estimator whose walk would not queue goes to
        // Profile to look, and sign-out is what lives there.
        //
        // Same words as Profile's recovery card for the same condition, because it is the same
        // condition: no signed-in identity means no manifest namespace to file into.
        noteRefusal({
          walkId: finishedWalkId,
          walk: finishedWalk,
          meta,
          message: "Sign in again before queueing this walk.",
        });
        return;
      }
      try {
        const queued = await enqueueWalk(ownerKey, finishedWalkId, finishedWalk, meta);
        // Scoped to the walk this call was about: a late retry landing after a LATER walk failed to
        // queue must not clear the notice standing for that one.
        setUnqueuedWalks((current) => current.filter((entry) => entry.walkId !== finishedWalkId));
        // null = nothing to enqueue (not yet terminal, or terminal with zero captured artifacts —
        // e.g. failed before anything was recorded). Only kick a drain when there is something to
        // drain; the background task above still covers the case where this foreground kick itself
        // gets interrupted.
        if (queued) void drainWalkQueue(ownerKey, queueFetcher, walkthroughUploadClient).catch(() => undefined);
      } catch (error) {
        // The walk's artifacts are still on disk (nothing is deleted before a successful completion
        // call — see upload.ts), so this is recoverable in principle. What it is not is discoverable:
        // the startup orphan scan is the only thing that would ever find them again, and it needs the
        // estimator to reopen the app and go looking for a problem nobody mentioned. So it is said
        // here, where they are standing, with the one action that fixes it.
        if (enqueuedWalkIdRef.current === finishedWalkId) enqueuedWalkIdRef.current = null;
        // The MESSAGE, not the stringified Error: the banner reads "…it could not be handed to the
        // upload queue: {message}", and "Error: No space left on device" puts a prefix in front of
        // the only clause the estimator can act on.
        noteRefusal({
          walkId: finishedWalkId,
          walk: finishedWalk,
          meta,
          message: errorMessage(error),
        });
      }
    },
    [ownerKey, queueFetcher, noteRefusal],
  );

  const retryFiling = useCallback(
    (entry: UnqueuedWalk) => {
      // State-only guard, no synchronous ref latch — unlike Profile's recovery card, where a
      // double-tap races over WHICH DEAL the walk gets filed against. Here both halves of a
      // double-tap carry the SAME walkId, walk and meta, and enqueueWalk is idempotent per walkId,
      // so the worst a duplicate can do is write the same manifest entry twice.
      if (refilingWalkIds.includes(entry.walkId)) return;
      setRefilingWalkIds((current) => [...current, entry.walkId]);
      void fileWalk(entry.walkId, entry.walk, entry.meta).finally(() =>
        setRefilingWalkIds((current) => current.filter((walkId) => walkId !== entry.walkId)),
      );
    },
    [refilingWalkIds, fileWalk],
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
    void fileWalk(walkId, walk, meta);
  }, [walk, walkId, ownerKey, targetName, propertyAddress, queueFetcher, fileWalk]);

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
    if (walk.state !== "recording") return undefined;
    // `activateKeepAwakeAsync` is async, and a walk can leave "recording" before it answers — a walk
    // ended after a few seconds, or one that failed the instant it started. The cleanup then ran
    // while keptAwakeRef was still false, found nothing to release, and the late fulfilment set the
    // ref true afterwards with its only cleanup already gone. Nothing was left holding a reference
    // to that lock, so the screen stayed awake until the app was killed — on a phone that has by
    // then gone into a pocket. This flag is what lets the LATE arrival do the release the cleanup
    // could not: it is the same lock either way, just acquired after the moment it was wanted.
    let cancelled = false;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG)
      .then(() => {
        if (cancelled) {
          void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
          return;
        }
        keptAwakeRef.current = true;
      })
      .catch(() => {
        // Best-effort, same as upload-queue's drain lock — a walk still records without it. The ref
        // stays false on purpose: nothing was acquired, so nothing must be released.
      });
    return () => {
      cancelled = true;
      if (keptAwakeRef.current) {
        keptAwakeRef.current = false;
        void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      }
    };
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

  // No deal, no walk — and the refusal has to happen HERE, before any control that starts a
  // recording is drawn.
  //
  // This is a hidden route: it is reachable by opening it directly, or by a link whose dealId got
  // dropped, and `dealId` is normalised to "" in both cases. The screen still rendered a working
  // Start button, so the estimator could walk a whole site — video, narration, stills, all written
  // to disk — before anything noticed. The failure surfaced only in the upload queue, where the
  // dealId is a PATH SEGMENT (`/field/projects/<dealId>/glasses-walkthroughs`): an empty one
  // collapses the path, every attempt fails, and the walk goes terminal on the failed-walk card
  // with no deal anyone can attach it to afterwards. Refusing costs one tap; allowing it costs the
  // site visit. Deliberately below the bridge check — a build with no recorder cannot record for
  // ANY deal, which is the more fundamental thing to say.
  if (!dealId) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.centered}>
          <Text style={styles.missingTitle}>No project selected</Text>
          <Text style={styles.missingBody}>
            A walk is filed against a project, and this screen was opened without one. Go back and
            start the walk from the project you are visiting.
          </Text>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}
          >
            <Text style={styles.doneButtonText}>Go back</Text>
          </Pressable>
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

        {/* Outside every walk.state branch, deliberately, and for a different reason than the banner
            above: these notices are about walks that are already OVER, so hanging them off the
            completion card would put them inside the one thing the focus effect wipes. Each stays
            until ITS walk is queued — including through the walks the estimator starts next, because
            an unfiled site visit outranks the tidiness of the screen it is sitting on. One banner per
            refused walk, never a summary count: the message is the queue's own words about THAT
            walk, and the retry has to be attached to the recording it re-files. */}
        {unqueuedWalks.map((unqueuedWalk) => {
          const retrying = refilingWalkIds.includes(unqueuedWalk.walkId);
          return (
            <View key={unqueuedWalk.walkId} style={styles.unqueuedBanner}>
              <Text style={styles.unqueuedTitle}>This walk has not been queued</Text>
              {/* WHICH walk, in the same words the office will see it under (deriveWalkTitle's
                  target + date/time). Two identical banners would leave the estimator retrying one
                  of them twice and never learning which recording is still unfiled. */}
              <Text style={styles.unqueuedBody}>{unqueuedWalk.meta.title}</Text>
              <Text style={styles.unqueuedBody}>
                Nothing has been deleted — the recording is still on this phone — but it could not be
                handed to the upload queue: {unqueuedWalk.message}
              </Text>
              <Text style={styles.unqueuedBody}>
                Free up storage if the phone is full, then try again. It uploads on its own once it is
                queued.
              </Text>
              <Pressable
                onPress={() => retryFiling(unqueuedWalk)}
                disabled={retrying}
                accessibilityRole="button"
                // Every banner's button reads "Try again", so the walk's title is what tells a screen
                // reader WHICH recording this one re-files — same rule as Profile's recovery rows.
                accessibilityLabel={`Try queueing this walk again — ${unqueuedWalk.meta.title}`}
                accessibilityState={{ disabled: retrying, busy: retrying }}
                style={({ pressed }) => [
                  styles.unqueuedRetry,
                  retrying && styles.startButtonBusy,
                  pressed && !retrying && styles.pressed,
                ]}
              >
                <Text style={styles.unqueuedRetryText}>{retrying ? "Trying…" : "Try again"}</Text>
              </Pressable>
            </View>
          );
        })}

        {walk.state === "idle" || walk.state === "starting" ? (
          <View style={styles.centered}>
            <Text style={styles.aboutToLabel}>About to record</Text>
            <Text style={styles.aboutToTarget} numberOfLines={2}>
              {targetName}
            </Text>
            {/* Only while IDLE. Once a walk is "starting" native owns the sequence and this gate has
                no say left — swapping the "Starting…" button out from under a start already in
                flight would say the walk was refused when it was not. Deliberately NOT one of the
                full-screen early returns above (bridge, no deal): those are known at first render,
                this arrives from an async read that can land at any moment, and blanking the screen
                out from under a live recording is the one thing this file must never do. */}
            {walk.state === "idle" && cameraBlocked ? (
              /* describePairing's own label and detail, verbatim — the estimator reads the same
                 sentence here as on Profile, about the same device and the same permission. No
                 Start button at all rather than a disabled one, matching the two refusals above:
                 a control that cannot work invites exactly the silent-tap confusion this screen
                 spends its whole layout avoiding. */
              <>
                <Text style={styles.missingTitle}>{cameraBlocked.label}</Text>
                <Text style={styles.missingBody}>{cameraBlocked.detail}</Text>
                {/* The fix, on the screen where the problem is stated. The estimator is standing on
                    the job site: sending them to Profile to find the same button would be telling
                    them no and leaving them to work out where yes lives. */}
                <Pressable
                  onPress={() => void requestCameraAccess()}
                  disabled={requestingCamera}
                  accessibilityRole="button"
                  accessibilityLabel="Grant camera access"
                  accessibilityState={{ disabled: requestingCamera, busy: requestingCamera }}
                  style={({ pressed }) => [
                    styles.grantButton,
                    requestingCamera && styles.startButtonBusy,
                    pressed && !requestingCamera && styles.pressed,
                  ]}
                >
                  <Text style={styles.grantButtonText}>
                    {requestingCamera ? "Asking Meta…" : "Grant camera access"}
                  </Text>
                </Pressable>
                {cameraRequestNotice ? (
                  <Text style={styles.grantNotice}>{cameraRequestNotice}</Text>
                ) : null}
              </>
            ) : (
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
            )}
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
            {/* The recording's own file is closing on the largest single artifact the office can
                accept (session.ts's MAX_WALK_ARTIFACT_BYTES). Said HERE, while the estimator can
                still choose the moment: finish the elevation you are on, end the walk, and start
                another. If nothing is done the walk ends itself a few minutes from now — which is
                strictly better than a recording nothing can upload, but far worse than a stop the
                estimator picked. Warning colour, not danger: nothing has gone wrong yet. */}
            {videoSize === "nearLimit" ? (
              <Text style={styles.captureLimitNotice}>
                This recording is close to the largest recording that can be uploaded — finish up and
                end the walk. You can start another walk on this project straight away.
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
            {/* Why the walk ended without anyone tapping End. A recording that stops on its own and
                says nothing is indistinguishable from one ended by a mis-tap — on a screen that goes
                to some trouble to make End hard to hit by accident, that reads as a fault. It is
                not: the file is finalised, complete and uploading, and the ONE thing the estimator
                needs to know is that the rest of the site is a second walk. Same warning register as
                the coverage notices below, for the same reason — nothing failed. */}
            {stoppedAtSizeLimit ? (
              <View style={styles.mediaShortNotice}>
                <Text style={styles.mediaShortTitle}>Walk ended at the size limit</Text>
                <Text style={styles.mediaShortBody}>
                  This recording reached the largest size that can be uploaded, so it was saved and
                  ended here — nothing has been lost, and everything captured is uploading. If you
                  have more of the site to cover, start another walk on this project.
                </Text>
              </View>
            ) : null}
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

  // Warning, not danger: the recording is intact and one tap from being saved, and dressing that in
  // the same red as a walk that failed outright would read as the loss it is not.
  unqueuedBanner: {
    backgroundColor: theme.color.warning,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    gap: theme.space.sm,
  },
  unqueuedTitle: {
    color: theme.color.brandBlack,
    fontSize: 15,
    fontFamily: theme.font.bold,
  },
  unqueuedBody: {
    color: theme.color.brandBlack,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: theme.font.medium,
  },
  unqueuedRetry: {
    alignSelf: "flex-start",
    backgroundColor: theme.color.brandBlack,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.lg,
  },
  unqueuedRetryText: {
    color: theme.color.textInverse,
    fontSize: 15,
    fontFamily: theme.font.bold,
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

  // Deliberately smaller than startButton: this is the thing standing BETWEEN the estimator and the
  // walk, not the walk itself, and sizing it like Start would train the same reach for two different
  // outcomes. Its own styles rather than borrowing doneButton's — that one belongs to the completion
  // screen, and a future restyle there must not silently move this.
  grantButton: {
    marginTop: theme.space.lg,
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.space.lg,
    paddingHorizontal: theme.space.xxl,
    alignItems: "center",
  },
  grantButtonText: {
    color: theme.color.textInverse,
    fontSize: 18,
    fontFamily: theme.font.bold,
  },
  grantNotice: {
    color: theme.color.warning,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: theme.font.medium,
    textAlign: "center",
    marginTop: theme.space.md,
    maxWidth: 340,
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
