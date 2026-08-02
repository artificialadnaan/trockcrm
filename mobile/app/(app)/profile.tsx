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
import { apiFetch } from "../../src/api/client";
import type { Fetcher } from "../../src/api/endpoints";
import { walkOwnerKey } from "../../src/walkthrough/owner-key";
import { drainWalkQueue, getFailedWalkCount, retryFailedWalks } from "../../src/walkthrough/upload";
import { walkthroughUploadClient } from "../../src/walkthrough/upload-client";

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
  const { user, activeOfficeId, token, signOut } = useAuth();
  // Same resolution rule as walk.tsx and the background drain task (activeOfficeId ?? primary
  // office) — this MUST match theirs, or this card would count/retry a manifest namespace neither
  // of them ever actually wrote walks into.
  const resolvedOfficeId = activeOfficeId ?? user?.tenantId ?? null;
  const ownerKey = walkOwnerKey(user?.id, resolvedOfficeId);
  const queueFetcher = React.useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, { ...opts, token: token ?? undefined, officeId: resolvedOfficeId, onUnauthorized: () => void signOut() }),
    [token, resolvedOfficeId, signOut],
  );

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
