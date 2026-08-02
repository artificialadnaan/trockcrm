import React from "react";
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { theme } from "../../src/theme/theme";
import { Badge, Button, Card } from "../../src/components/ui";
import { ScreenHeader } from "../../src/components/ScreenHeader";
import { getSaveToCameraRoll, setSaveToCameraRoll } from "../../src/settings/camera-roll-setting";
import { Wearables, isAvailable as wearablesBridgeAvailable } from "../../src/wearables/native";
import { describePairing, type Pairing, type PairingStatus } from "../../src/walkthrough/pairing";
import { useWalkQueueSession } from "../../src/walkthrough/use-queue-session";
import {
  drainWalkQueue,
  enqueueRecoveredWalk,
  forgetRecoveredWalk,
  getFailedWalkCount,
  getRecoverableWalksFromStartup,
  retryFailedWalks,
  subscribeRecoverableWalksFromStartup,
  subscribeWalkQueue,
  type RecoveredWalk,
} from "../../src/walkthrough/upload";
import {
  UNKNOWN_WALK_TIME,
  deriveRecoveredWalkTitle,
  deriveWalkSiteLabel,
  formatWalkDateTime,
} from "../../src/walkthrough/walk-meta";
import { walkthroughUploadClient } from "../../src/walkthrough/upload-client";
import { TargetPicker } from "../../src/components/TargetPicker";
import type { FieldCaptureTarget } from "../../src/api/types";

const SUPPORT_HUB_URL = "https://support-hub-production.up.railway.app/";

/** Dot color per pairing status — the only visual signal that doesn't repeat the label text. */
function pairingDotColor(status: PairingStatus): string {
  if (status === "ready") return theme.color.success;
  if (status === "unavailable") return theme.color.textMuted;
  return theme.color.warning;
}

/**
 * Glasses pairing status, visible in release builds — a crew needs to know whether their glasses
 * are ready without a developer present. Reads `Wearables.configure()` / `.status()` /
 * `.diagnose()` on mount, on manual refresh, and again whenever the app regains foreground focus
 * (covers the round trip through the Meta AI app after tapping Pair, which this screen never
 * unmounts for).
 *
 * Every native call can reject. A rejection never blanks the row: if a previous check already
 * succeeded, that result stays on screen (flagged as possibly stale) rather than being replaced
 * by an error; if nothing has succeeded yet, the error itself is shown so the row never renders
 * empty.
 */
function PairingRow() {
  const [pairing, setPairing] = React.useState<Pairing | null>(null);
  const [checkError, setCheckError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [pairError, setPairError] = React.useState<string | null>(null);
  const [requestingCamera, setRequestingCamera] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const check = React.useCallback(async () => {
    setChecking(true);
    if (!wearablesBridgeAvailable) {
      // No native module in this build — describePairing's first branch handles this without
      // needing any of the calls below, which would only throw "module is missing" anyway.
      if (mountedRef.current) {
        setPairing(
          describePairing({
            bridgeAvailable: false,
            configured: false,
            registrationState: "",
            deviceCount: 0,
            deviceName: null,
            linkState: null,
            cameraPermission: null,
          }),
        );
        setCheckError(null);
        setChecking(false);
      }
      return;
    }
    try {
      const configureResult = await Wearables.configure();
      const status = await Wearables.status();
      // diagnose()'s cameraPermission was previously read and discarded here — a registered,
      // connected device was labelled "Ready" even with no camera authorization, and the recorder
      // cannot start a stream without it. Threading it into describePairing is what closes that.
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
      if (mountedRef.current) {
        setPairing(next);
        setCheckError(null);
      }
    } catch (error) {
      if (mountedRef.current) setCheckError(String(error));
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  React.useEffect(() => {
    void check();
    // Covers the Pair handoff: startRegistration() foregrounds the Meta AI app, and the SDK only
    // learns the outcome once we come back. This screen stays mounted the whole time (it's a tab),
    // so a plain AppState listener — not a focus effect — is what actually observes the return.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void check();
    });
    return () => sub.remove();
  }, [check]);

  const pair = React.useCallback(async () => {
    setStarting(true);
    setPairError(null);
    try {
      await Wearables.startRegistration();
      // No further action here — control has handed off to the Meta AI app. The AppState
      // listener above re-checks status the moment this app regains focus.
    } catch (error) {
      setPairError(String(error));
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  }, []);

  // Wearables.requestCameraPermission() was previously reachable only from the __DEV__ diagnostic
  // screen — a release user who had never granted Meta's camera permission had NO way to grant it,
  // and the recorder cannot start a stream without it. This is that path, offered right where
  // describePairing now reports the problem (status "cameraBlocked"). Unlike startRegistration(),
  // this resolves in-process rather than handing off to another app, so re-checking right after is
  // enough — no AppState round trip needed.
  const requestCamera = React.useCallback(async () => {
    setRequestingCamera(true);
    setCameraError(null);
    try {
      await Wearables.requestCameraPermission();
    } catch (error) {
      if (mountedRef.current) setCameraError(String(error));
    } finally {
      if (mountedRef.current) setRequestingCamera(false);
    }
    // Re-check regardless of outcome, so the row reflects whatever the SDK actually did (granted,
    // or still denied) rather than assuming the request succeeded.
    void check();
  }, [check]);

  const title = pairing ? pairing.label : checkError ? "Couldn't check glasses" : "Checking glasses…";
  const detail = pairing ? pairing.detail : checkError ? checkError : "Reading pairing status…";
  const dotColor = pairing ? pairingDotColor(pairing.status) : checkError ? theme.color.warning : theme.color.textMuted;

  return (
    <Card style={styles.card}>
      <View style={styles.settingRow}>
        <View style={[styles.pairingDot, { backgroundColor: dotColor }]} />
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>{title}</Text>
          <Text style={styles.settingHint}>{detail}</Text>
          {checkError && pairing ? (
            <Text style={styles.pairingStale}>Couldn't refresh — showing the last status checked.</Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => void check()}
          disabled={checking}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Refresh glasses status"
          accessibilityState={{ disabled: checking, busy: checking }}
        >
          {checking ? (
            <ActivityIndicator size="small" color={theme.color.textMuted} />
          ) : (
            <Ionicons name="refresh-outline" size={20} color={theme.color.textMuted} />
          )}
        </Pressable>
      </View>

      {pairing?.status === "unpaired" ? (
        <Button
          title="Pair glasses"
          variant="ghost"
          loading={starting}
          onPress={() => void pair()}
          icon={<Ionicons name="glasses-outline" size={18} color={theme.color.textPrimary} />}
        />
      ) : null}
      {pairError ? <Text style={styles.pairingStale}>{pairError}</Text> : null}

      {pairing?.status === "cameraBlocked" ? (
        <Button
          title="Grant camera access"
          variant="ghost"
          loading={requestingCamera}
          onPress={() => void requestCamera()}
          icon={<Ionicons name="camera-outline" size={18} color={theme.color.textPrimary} />}
        />
      ) : null}
      {cameraError ? <Text style={styles.pairingStale}>{cameraError}</Text> : null}
    </Card>
  );
}

/**
 * Surfaces walks that exhausted every upload retry (upload-core.ts's MAX_WALK_UPLOAD_ATTEMPTS /
 * MAX_WALK_COMPLETION_ATTEMPTS) and gives a way back in.
 *
 * Before this, getFailedWalkCount had NO call site anywhere in the app: a walk that went terminal
 * was excluded from getSchedulableWalkCount (so the background task would never touch it again),
 * and walk.tsx's own foreground drain discards its result entirely. The recording just sat on the
 * phone, unrecoverable, with nothing telling the estimator a site visit had silently failed to
 * ship. This card is that "something."
 *
 * It lives on Profile rather than the walk screen because Profile is a real, always-present tab
 * the estimator returns to regularly, independent of which specific deal they were last walking —
 * walk.tsx, by contrast, is only ever open for ONE deal at a time and is easy to never revisit.
 * Renders nothing when there is nothing failed, so a healthy queue adds no clutter.
 */
function FailedWalksCard() {
  // Office resolution and 401 scoping both come from the shared hook — this card's retry drain can
  // outlive Profile (it unmounts with the shell at sign-out), so an unguarded onUnauthorized here
  // could sign out whoever signs in next. See use-queue-session.ts.
  const { ownerKey, queueFetcher } = useWalkQueueSession();

  const [failedCount, setFailedCount] = React.useState(0);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    if (!ownerKey) {
      if (mountedRef.current) setFailedCount(0);
      return;
    }
    try {
      const count = await getFailedWalkCount(ownerKey);
      if (mountedRef.current) setFailedCount(count);
    } catch {
      // Best-effort — a failed manifest read here shows the last-known count rather than crashing
      // the profile screen.
    }
  }, [ownerKey]);

  // Profile is a REAL (visible) tab, unlike walk.tsx — a plain focus effect is enough to re-check
  // whenever the estimator lands back here, no AppState round trip needed.
  useFocusEffect(
    React.useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  // ...and SUBSCRIBED on top of that, for the same reason RecoverableWalksCard below subscribes
  // rather than just reading. Focus answers "what was true when I arrived"; the interesting moment is
  // a walk exhausting its last retry, and that happens inside a drain running detached from every
  // screen (kicked off by the walk screen, the shell, the background task, or this card's own retry
  // button, all of which outlive their caller). With only the focus read, a walk going terminal while
  // the estimator was ALREADY sitting on Profile published nothing, and the card stayed hidden until
  // they navigated away and back — a step nobody takes about a card they cannot see. The count is an
  // async manifest read rather than a synchronous snapshot, so this is a subscribe-and-re-read rather
  // than useSyncExternalStore; a redundant re-read (another owner's mutation, or a mid-drain PUT that
  // changed nothing this card shows) costs one small JSON parse and renders the same value.
  React.useEffect(() => subscribeWalkQueue(() => void refresh()), [refresh]);

  const retry = React.useCallback(async () => {
    if (!ownerKey) return;
    setRetrying(true);
    setRetryError(null);
    try {
      // Reset every terminal walk's retry counters, THEN drain — retryFailedWalks alone doesn't
      // upload anything, it only makes those walks drainable again (see upload.ts).
      await retryFailedWalks(ownerKey);
      await drainWalkQueue(ownerKey, queueFetcher, walkthroughUploadClient);
    } catch (error) {
      if (mountedRef.current) setRetryError(String(error));
    } finally {
      if (mountedRef.current) setRetrying(false);
      await refresh();
    }
  }, [ownerKey, queueFetcher, refresh]);

  if (failedCount === 0) return null;

  return (
    <Card style={styles.card}>
      <View style={styles.settingRow}>
        <View style={[styles.pairingDot, { backgroundColor: theme.color.danger }]} />
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>
            {failedCount} walk{failedCount === 1 ? "" : "s"} failed to upload
          </Text>
          <Text style={styles.settingHint}>
            Recorded on this device but couldn't be sent after several tries. Nothing is lost —
            tap retry to try again.
          </Text>
          {retryError ? <Text style={styles.pairingStale}>{retryError}</Text> : null}
        </View>
      </View>
      <Button
        title="Retry upload"
        variant="ghost"
        loading={retrying}
        onPress={() => void retry()}
        icon={<Ionicons name="cloud-upload-outline" size={18} color={theme.color.textPrimary} />}
      />
    </Card>
  );
}

/**
 * Everything the device can truthfully say about ONE orphaned walk, as a single line: when it was
 * recorded, what it holds, and how long it ran.
 *
 * This is not decoration — it is the input to the only decision that can save the recording. A walk
 * directory carries no dealId (see findRecoverableWalks), so the estimator has to say which job it
 * was, and the recorded time is the one clue on disk that narrows that down. Every part is omitted
 * rather than guessed when the platform cannot report it: a fabricated "just now" on a two-day-old
 * walk would aim them at the wrong site, which is precisely the failure this whole path avoids.
 *
 * The span is labelled "at least" on purpose. It is first-write to last-write, and recording began
 * before the first byte landed, so it is a lower bound on the walk's length — not its duration.
 *
 * The video has THREE states here, not two, and collapsing them would misinform in both directions.
 * A walk.mp4 the writer never closed (an app kill mid-recording) is unplayable, so "1 recording"
 * would promise the office a file that will not open — but "no photos"-style silence is no better,
 * because someone who remembers recording a video needs to know what became of it rather than
 * quietly concluding this is a different walk. So it is named for what it is.
 */
function describeRecoveredWalk(walk: RecoveredWalk): string {
  const stills = walk.stillUris.length;
  const contents = [
    walk.videoUri ? "1 recording" : walk.unfinishedVideo ? "video unusable (not uploaded)" : "no video",
    stills === 0 ? "no photos" : stills === 1 ? "1 photo" : `${stills} photos`,
  ].join(", ");
  const spanMinutes = walk.captureSpanMs === null ? null : Math.round(walk.captureSpanMs / 60_000);
  return [
    walk.recordedAtMs === null ? UNKNOWN_WALK_TIME : formatWalkDateTime(walk.recordedAtMs),
    contents,
    spanMinutes === null ? null : spanMinutes < 1 ? "under a minute" : `at least ${spanMinutes} min`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * Surfaces walk recordings found on disk with no queue entry — an app kill mid-recording, a
 * sign-out, or a finalize that landed after the enqueue effect was already gone — and gives the one
 * action that can actually save them: filing each against a project the ESTIMATOR names.
 *
 * This card used to end at "mention this to support", and that was worse than unhelpful — it was
 * false. The files sit inside this app's own sandbox; support cannot reach them, so the advice sent
 * someone to a door that does not open while an unrepeatable site visit sat on the phone.
 *
 * There is still no "Upload" button, and that part of the old reasoning was right: the server needs
 * a dealId on both endpoints, nothing on disk carries one, and a walk filed against the WRONG job is
 * worse than an unfiled walk — nobody catches it until a scope comes back describing the wrong
 * building. What changed is who answers the question. The estimator was there; they know. So the
 * action opens the app's existing project picker rather than guessing, and the row shows what the
 * device knows about the walk (see describeRecoveredWalk) so the choice is informed.
 *
 * PER WALK, not aggregated, for the same reason: two orphans can be two different jobs, and a single
 * card-wide action could only ever file them all against one deal.
 *
 * Reads the snapshot taken by `(app)/_layout.tsx` at shell mount rather than scanning here: an
 * ACTIVE walk has no manifest entry either, so a scan run while recording would report the live
 * walk as orphaned.
 */
function RecoverableWalksCard() {
  // SUBSCRIBED, not just read. That scan is async and starts in the shell's mount effect, so on a
  // cold launch that lands straight on Profile this card renders before it has an answer. Reading
  // the module getter alone left it stuck on that first empty answer: finishing the scan publishes
  // no React state, so nothing schedules a rerender, and the card stayed hidden — with real
  // recordings on the phone — until some unrelated parent rerender happened to sweep it back in.
  // useSyncExternalStore is the exact fit: the module owns the value, this just needs to be told
  // when it lands (and the getter returns a stable empty array so the snapshot is identity-safe).
  // The same subscription is what makes a filed walk's row DISAPPEAR: forgetRecoveredWalk edits the
  // snapshot and publishes (it must never re-scan — see its doc comment).
  const recoverable = React.useSyncExternalStore(
    subscribeRecoverableWalksFromStartup,
    getRecoverableWalksFromStartup,
  );
  // Same shared hook as FailedWalksCard: the drain this card kicks outlives Profile, so it must not
  // carry sign-out authority, and its office resolution has to match the manifest namespace exactly.
  const { ownerKey, queueFetcher } = useWalkQueueSession();

  // Which walk the picker is currently choosing a project FOR. Null closes the picker — and closing
  // it is the whole of "backing out": nothing on disk or in the manifest has been touched yet.
  const [picking, setPicking] = React.useState<RecoveredWalk | null>(null);
  const [filingWalkId, setFilingWalkId] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // SYNCHRONOUS double-file latch (setFilingWalkId only lands next render), same shape as
  // capture.tsx's finishingRef. enqueueRecoveredWalk is idempotent per walkId so a duplicate cannot
  // queue two copies of the recording — but two overlapping calls WOULD race over which deal wins,
  // and the loser's picker would report success for a filing that never happened.
  const filingRef = React.useRef<string | null>(null);

  const file = React.useCallback(
    async (walk: RecoveredWalk, target: FieldCaptureTarget) => {
      if (!ownerKey) {
        setFileError("Sign in again before filing this walk.");
        return;
      }
      if (filingRef.current) return;
      filingRef.current = walk.walkId;
      setFilingWalkId(walk.walkId);
      setFileError(null);
      try {
        // The walk's own recorded time, NULL AND ALL: a recovered walk has no reducer history, so
        // toRecoveredQueuedWalk leaves startedAt null and the completion call's capturedAt falls
        // back to the DRAIN moment. The title is therefore the only place the office learns when
        // this visit actually happened — and "(recovered)" is how they learn that the timeline was
        // reconstructed from the files rather than recorded live. Passing `Date.now()` where the
        // platform reported no timestamp does not soften the claim, it dates a week-old site visit
        // to today with exactly the confidence of a real reading, and undoes the honesty the row
        // above it was written for. deriveRecoveredWalkTitle carries the unknown through and does
        // its own MAX_TITLE_CHARS clamping with the marker already composed in.
        const meta = {
          title: deriveRecoveredWalkTitle(target.name, walk.recordedAtMs),
          // Genuinely unknown here: the picker's target carries no property address, and inventing
          // one from the company or project name would put a non-address in the field the office
          // reads as the site. "" is how the wire type says "absent".
          siteLabel: deriveWalkSiteLabel(null),
        };
        // projectId null for the same reason — a directory on disk says nothing about which CRM
        // project the walk belongs to, and the deal alone is what the server actually requires.
        const queued = await enqueueRecoveredWalk(ownerKey, walk, target.id, null, meta);
        if (!queued) {
          // The directory had neither a video nor a still by the time this ran — it raced a cleanup.
          // The row deliberately STAYS: nothing was queued, so retiring it would hide a walk the
          // estimator still thinks they saved.
          if (mountedRef.current) setFileError("That recording is no longer on this device.");
          return;
        }
        // Only after the manifest write succeeded. Retiring the row on a FAILED enqueue would hide
        // the orphan for the rest of this shell lifecycle, with nothing left that could file it.
        forgetRecoveredWalk(ownerKey, walk.walkId);
        // Detached, exactly like walk.tsx's post-enqueue kick. The walk is durable the moment the
        // manifest write landed, and a multi-GB video must not hold this card's busy state (or die
        // with it) — from here it is an ordinary queued walk, retried by the shell and the
        // background task like any other.
        void drainWalkQueue(ownerKey, queueFetcher, walkthroughUploadClient).catch(() => undefined);
      } catch (error) {
        if (mountedRef.current) setFileError(String(error));
      } finally {
        filingRef.current = null;
        if (mountedRef.current) setFilingWalkId(null);
      }
    },
    [ownerKey, queueFetcher],
  );

  if (recoverable.length === 0) return null;

  return (
    <Card style={styles.card}>
      <View style={styles.settingRow}>
        <View style={[styles.pairingDot, { backgroundColor: theme.color.warning }]} />
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>
            {recoverable.length} unfinished walk{recoverable.length === 1 ? "" : "s"} on this device
          </Text>
          {/* No "nothing is lost" here. It is the reassurance the card wants to give and the one it
              cannot always support: a walk killed mid-recording can leave a video nothing can open,
              and a row that says so under a headline promising otherwise is the card arguing with
              itself. Each row states what it actually has; this says what to do about it. */}
          <Text style={styles.settingHint}>
            Captured here but never attached to a project — the app closed before the walk finished.
            Pick the project you were walking and everything usable uploads like any other walk.
          </Text>
          {fileError ? <Text style={styles.pairingStale}>{fileError}</Text> : null}
        </View>
      </View>

      {recoverable.map((walk) => {
        const described = describeRecoveredWalk(walk);
        return (
          <View key={walk.walkId} style={styles.recoveredRow}>
            <Text style={styles.settingHint}>{described}</Text>
            <Button
              title="File to a project"
              variant="ghost"
              loading={filingWalkId === walk.walkId}
              onPress={() => setPicking(walk)}
              // Every row's button says the same thing, so the description is what tells a screen
              // reader WHICH walk this one files — and that is the whole basis of the choice.
              accessibilityLabel={`File this walk to a project — ${described}`}
              icon={<Ionicons name="briefcase-outline" size={18} color={theme.color.textPrimary} />}
            />
          </View>
        );
      })}

      {/* Mounted only while a project is being chosen. TargetPicker runs a deal search (and a GPS
          lookup for its nearby list) from its own hooks the moment it exists, and Profile is not
          otherwise a data screen — keeping it unmounted means opening settings costs neither.
          `dealsOnly` because both walkthrough endpoints are addressed by dealId; a lead or an
          opportunity is not a destination this walk can be filed to at all. */}
      {picking ? (
        <TargetPicker
          visible
          dealsOnly
          onClose={() => setPicking(null)}
          onSelect={(target) => {
            const walk = picking;
            setPicking(null);
            void file(walk, target);
          }}
        />
      ) : null}
    </Card>
  );
}

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  rep: "Rep",
  construction: "Construction",
  field_contractor: "Field",
};

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const firstName = user?.firstName?.trim();

  const [saveToRoll, setSaveToRoll] = React.useState(true);
  // If the user toggles BEFORE the async load resolves, the load must not clobber their choice.
  const interactedRef = React.useRef(false);
  React.useEffect(() => {
    let active = true;
    void getSaveToCameraRoll().then((value) => {
      if (active && !interactedRef.current) setSaveToRoll(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleSaveToRoll = (value: boolean) => {
    interactedRef.current = true;
    setSaveToRoll(value); // optimistic — reflect the choice immediately
    void setSaveToCameraRoll(value); // persist (best-effort; the setting keeps an in-session override)
  };

  const openSupportTicket = () => {
    void Linking.openURL(SUPPORT_HUB_URL).catch(() => {
      // Opening the support hub is best-effort; if no handler can take the URL there's nothing to recover.
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />
      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.card}>
          <Text style={styles.greeting}>Hi{firstName ? `, ${firstName}` : ""} 👋</Text>
          {user?.email ? <Text style={styles.email}>{user.email}</Text> : null}
          {user?.role ? (
            <View style={styles.metaRow}>
              <Badge label={ROLE_LABEL[user.role] ?? user.role} />
            </View>
          ) : null}
          <Text style={styles.blurb}>
            Capture and organize jobsite photos, then build branded photo reports — all synced to T Rock CRM.
          </Text>
        </Card>

        <Card style={styles.card}>
          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingTitle}>Save photos to camera roll</Text>
              <Text style={styles.settingHint}>
                Keep a full-resolution backup of every capture on this device.
              </Text>
            </View>
            <Switch
              value={saveToRoll}
              onValueChange={toggleSaveToRoll}
              trackColor={{ true: theme.color.textPrimary }}
              accessibilityLabel="Save photos to camera roll"
              accessibilityHint="When on, a full-resolution backup of every capture is saved to this device's camera roll"
            />
          </View>
        </Card>

        <PairingRow />
        <FailedWalksCard />
        <RecoverableWalksCard />

        <Button
          title="Create Support Ticket"
          variant="ghost"
          onPress={openSupportTicket}
          icon={<Ionicons name="help-buoy-outline" size={18} color={theme.color.textPrimary} />}
        />

        {__DEV__ ? (
          <Button
            title="Wearables diagnostic"
            variant="ghost"
            onPress={() => router.push("/dev-wearables")}
            icon={<Ionicons name="glasses-outline" size={18} color={theme.color.textPrimary} />}
          />
        ) : null}

        <Button title="Sign out" variant="dangerGhost" onPress={() => void signOut()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, flexGrow: 1 },
  // Spacing comes from one mechanism (the card's gap), not per-child marginTop overrides (#43).
  card: { gap: theme.space.md },
  greeting: { fontFamily: theme.font.bold, fontSize: 22, color: theme.color.textPrimary },
  email: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted },
  metaRow: { flexDirection: "row", gap: theme.space.sm },
  blurb: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted, lineHeight: 20 },
  settingRow: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  // One recoverable walk = one row = one project choice, so each is visibly its own decision rather
  // than a bullet in a list the card acts on as a whole.
  recoveredRow: {
    gap: theme.space.sm,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    paddingTop: theme.space.md,
  },
  settingText: { flex: 1, gap: 2 },
  settingTitle: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textPrimary },
  settingHint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, lineHeight: 18 },
  pairingDot: { width: 10, height: 10, borderRadius: 5 },
  pairingStale: {
    fontFamily: theme.font.body,
    fontSize: 12,
    color: theme.color.warning,
    lineHeight: 16,
    marginTop: 2,
  },
});
