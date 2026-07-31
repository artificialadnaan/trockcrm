/**
 * Meta Wearables diagnostic. Development builds only.
 *
 * A ladder, not a UI: each rung runs one native call and shows its raw result, so a failure
 * names itself instead of surfacing as "glasses don't work". Rungs 1-6 are plumbing. Rungs 7
 * and 8 are the reason this screen exists — they return MEASUREMENTS that decide whether
 * walkthrough capture moves into this app:
 *
 *   7. Is `capturePhoto` full-sensor, or capped at the 720x1280 stream ceiling?
 *   8. Does Bluetooth HFP negotiate wideband (16 kHz, what ASR consumes) or narrowband (8 kHz)?
 *
 * Neither is documented. Both are one tap away here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { theme } from "../../src/theme/theme";
import {
  Wearables,
  isAvailable,
  onPhoto,
  type PhotoMeasurement,
} from "../../src/wearables/native";

type RungState = "idle" | "running" | "ok" | "fail";

type Rung = {
  key: string;
  label: string;
  run: () => Promise<unknown>;
  /** Rungs that produce a number rather than a pass/fail are called out visually. */
  measurement?: boolean;
};

export default function DevWearablesScreen() {
  // Route files cannot be conditionally registered, so the gate is here. A release build
  // renders nothing rather than exposing raw SDK controls to a crew on a jobsite.
  if (!__DEV__) return null;
  return <Diagnostic />;
}

function Diagnostic() {
  const [state, setState] = useState<Record<string, RungState>>({});
  const [result, setResult] = useState<Record<string, string>>({});
  const [callback, setCallback] = useState("");
  const photoSub = useRef<(() => void) | null>(null);

  useEffect(() => {
    photoSub.current = onPhoto((photo: PhotoMeasurement) => {
      setState((s) => ({ ...s, photo: "ok" }));
      setResult((r) => ({ ...r, photo: describePhoto(photo) }));
    });
    return () => photoSub.current?.();
  }, []);

  // The step that actually COMPLETES rung 3, and the one rung that had no owner.
  //
  // startRegistration() hands off to Meta AI, which returns on `trockcam://`. The SDK only
  // learns the outcome if that URL reaches handleUrl(). Nothing called it, and expo-router
  // claims incoming URLs for navigation, so the callback was consumed as a route and dropped.
  // Registration therefore never finished: deviceCount stayed 0 and every rung from 6 down
  // failed with "No eligible device available" — an error that names the glasses when the real
  // culprit was this missing line.
  useEffect(() => {
    const handle = (url: string) => {
      setCallback(url);
      Wearables.handleUrl(url)
        .then((r) => setCallback(`${url}\nhandled: ${r.handled}`))
        .catch((e) => setCallback(`${url}\n${String(e)}`));
    };
    // A cold launch from the callback delivers the URL here instead of as an event.
    void Linking.getInitialURL().then((url) => {
      if (url) handle(url);
    });
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => sub.remove();
  }, []);

  const rungs: Rung[] = [
    { key: "configure", label: "1  SDK configured", run: Wearables.configure },
    { key: "capabilities", label: "2  Developer Mode", run: Wearables.capabilities },
    { key: "register", label: "3  Start registration", run: Wearables.startRegistration },
    { key: "status", label: "4  Registration status", run: Wearables.status },
    // Reads every gate that feeds `noEligibleDevice` and names the one that failed, instead of
    // leaving you to guess between link state, compatibility, permission and a selector race.
    { key: "diagnose", label: "4b Why no eligible device", run: Wearables.diagnose },
    { key: "permission", label: "5  Camera permission", run: Wearables.requestCameraPermission },
    { key: "stream", label: "6  Start stream", run: Wearables.startStream },
    { key: "streamInfo", label: "6b Delivered frame size", run: Wearables.streamInfo },
    { key: "photo", label: "7  capturePhoto → size", run: Wearables.capturePhoto, measurement: true },
    {
      key: "audio",
      label: "8  HFP audio → sample rate",
      run: () => Wearables.recordGlassesAudio(10),
      measurement: true,
    },
    { key: "stop", label: "—  Stop stream", run: Wearables.stopStream },
  ];

  const run = useCallback(async (rung: Rung) => {
    setState((s) => ({ ...s, [rung.key]: "running" }));
    setResult((r) => ({ ...r, [rung.key]: "" }));
    try {
      const value = await rung.run();
      // capturePhoto only reports that the request was ACCEPTED; the image and its
      // dimensions arrive later on the photo event, so this rung stays "running".
      if (rung.key === "photo") {
        setResult((r) => ({ ...r, photo: "requested — waiting for image…" }));
        return;
      }
      setState((s) => ({ ...s, [rung.key]: "ok" }));
      setResult((r) => ({ ...r, [rung.key]: JSON.stringify(value, null, 1) }));
    } catch (error) {
      setState((s) => ({ ...s, [rung.key]: "fail" }));
      setResult((r) => ({ ...r, [rung.key]: String(error) }));
    }
  }, []);

  if (!isAvailable) {
    return (
      <View style={styles.centered}>
        <Text style={styles.missingTitle}>Native bridge not in this build</Text>
        <Text style={styles.missingBody}>
          WearablesBridge is compiled into the app target, so Expo Go and any dev client built
          before the DAT integration will not have it. Rebuild the dev client.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Wearables diagnostic</Text>
      <Text style={styles.subtitle}>
        Run 1–5, then 8, then 6 → 6b → 7. Rung 8 comes BEFORE rung 6: HFP must settle before a
        DAT stream starts, or the audio route fails silently. Rungs 7 and 8 return the
        measurements that decide the capture architecture.
      </Text>

      {/* Always rendered, even empty. A callback that never arrives is the single most likely
          failure here, and hiding the row would make that indistinguishable from the row not
          existing at all — which is exactly the confusion this screen is built to prevent. */}
      <View style={[styles.rung, styles.rungCallback]}>
        <View style={styles.rungHeader}>
          <Text style={[styles.mark, callback ? styles.markOk : styles.markIdle]}>
            {callback ? "✓" : "·"}
          </Text>
          <Text style={styles.rungLabel}>Registration callback (automatic)</Text>
        </View>
        <Text style={styles.output}>
          {callback || "waiting — run rung 3, approve in Meta AI, and return here"}
        </Text>
      </View>

      {rungs.map((rung) => {
        const s = state[rung.key] ?? "idle";
        return (
          <View key={rung.key} style={[styles.rung, rung.measurement && styles.rungMeasurement]}>
            <Pressable
              onPress={() => void run(rung)}
              disabled={s === "running"}
              style={({ pressed }) => [styles.rungHeader, pressed && styles.pressed]}
            >
              <Text style={[styles.mark, markStyle(s)]}>{mark(s)}</Text>
              <Text style={styles.rungLabel}>{rung.label}</Text>
              {s === "running" ? <ActivityIndicator size="small" /> : <Text style={styles.run}>RUN</Text>}
            </Pressable>
            {result[rung.key] ? <Text style={styles.output}>{result[rung.key]}</Text> : null}
          </View>
        );
      })}

      <Text style={styles.footer}>
        Photos and audio are written to the app&rsquo;s temp directory; the file URI is printed
        above so the clip can be pulled off the device and run through the real pipeline.
      </Text>
    </ScrollView>
  );
}

function describePhoto(photo: PhotoMeasurement): string {
  const mp = photo.megapixels ? `${photo.megapixels.toFixed(1)} MP` : "unknown size";
  const dims = photo.width && photo.height ? `${photo.width} × ${photo.height}` : "undecodable";
  const kb = (photo.bytes / 1024).toFixed(0);
  const verdict = photo.largerThanStreamCeiling
    ? "FULL-SENSOR — stills beat stream frames"
    : "stream-sized — stills buy nothing over frames";
  return `${photo.format} · ${dims} (${mp}) · ${kb} KB\n${verdict}\n${photo.fileUri}`;
}

const mark = (s: RungState) => (s === "ok" ? "✓" : s === "fail" ? "✗" : s === "running" ? "…" : "›");
const markStyle = (s: RungState) =>
  s === "ok" ? styles.markOk : s === "fail" ? styles.markFail : styles.markIdle;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.brandBlack },
  content: { padding: theme.space.lg, paddingBottom: theme.space.xxl + theme.space.lg },
  centered: {
    flex: 1, alignItems: "center", justifyContent: "center",
    padding: theme.space.xl, backgroundColor: theme.color.brandBlack,
  },
  missingTitle: {
    color: theme.color.textInverse, fontSize: 17, fontFamily: theme.font.semibold,
    marginBottom: theme.space.sm, textAlign: "center",
  },
  missingBody: { color: theme.color.border, fontSize: 14, lineHeight: 20, textAlign: "center" },
  title: { color: theme.color.textInverse, fontSize: 22, fontFamily: theme.font.bold, marginBottom: theme.space.xs },
  subtitle: { color: theme.color.border, fontSize: 13, lineHeight: 19, marginBottom: theme.space.lg },
  rung: {
    backgroundColor: theme.color.overlay, borderRadius: theme.radius.sm,
    marginBottom: theme.space.sm, overflow: "hidden",
  },
  // The two measurement rungs are marked with the brand red: they are the reason the
  // screen exists, and everything above them is plumbing.
  rungMeasurement: { borderTopWidth: 2, borderTopColor: theme.color.brandRed },
  // Not a rung: it fires on its own when Meta AI returns, so it is marked apart from the
  // things you tap.
  rungCallback: { borderTopWidth: 2, borderTopColor: theme.color.success },
  rungHeader: { flexDirection: "row", alignItems: "center", gap: theme.space.md, padding: theme.space.md },
  pressed: { opacity: 0.7 },
  mark: { fontSize: 15, width: 16, fontVariant: ["tabular-nums"] },
  markOk: { color: theme.color.success },
  markFail: { color: theme.color.brandRed },
  markIdle: { color: theme.color.textMuted },
  rungLabel: { color: theme.color.textInverse, fontSize: 14, flex: 1, fontVariant: ["tabular-nums"] },
  run: { color: theme.color.textMuted, fontSize: 10, letterSpacing: 1.1, fontFamily: theme.font.bold },
  output: {
    color: theme.color.border, fontSize: 11.5, lineHeight: 17,
    paddingHorizontal: theme.space.md, paddingBottom: theme.space.md, fontFamily: "Menlo",
  },
  footer: { color: theme.color.textMuted, fontSize: 11.5, lineHeight: 17, marginTop: theme.space.md },
});
