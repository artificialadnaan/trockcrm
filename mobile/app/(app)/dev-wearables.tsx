/**
 * Meta Wearables diagnostic. Development builds only.
 *
 * A ladder, not a UI: each rung runs one native call and shows its raw result, so a failure
 * names itself instead of surfacing as "glasses don't work". Rungs 1-6 are plumbing.
 *
 * Rungs 7 and 8 are ANSWERED, measured on real hardware 2026-07-30:
 *
 *   7. `capturePhoto` is 1080x1440 (1.56 MP), full-sensor against the 720x1280 (0.92 MP) .high
 *      stream ceiling — stills win by 1.7x.
 *   8. Bluetooth HFP negotiates wideband (16 kHz, what ASR consumes).
 *
 * Rungs 9 and 10 are now the open Step 0 questions, and they gate the capture design:
 *
 *   9. Does the HFP mic route survive a DAT camera stream? If not, video and glasses audio
 *      cannot be captured together and the feature falls back to audio + stills.
 *   10. Does opening the phone camera tear down HFP? The feature needs phone stills during a
 *       glasses walk, and both share one `AVAudioSession`.
 *
 * One tap away here.
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
import {
  describeHfpStreamCheck,
  describePhoneCameraCheck,
  describeStreamEndurance,
} from "../../src/wearables/step0-verdicts";

type RungState = "idle" | "running" | "ok" | "fail";

/**
 * Narrow `rung.run()`'s `Promise<unknown>` return down to capturePhoto's actual shape
 * (`{ requested: boolean }`) with an honest runtime check, rather than casting.
 */
function isCapturePhotoResult(value: unknown): value is { requested: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "requested" in value &&
    typeof (value as { requested: unknown }).requested === "boolean"
  );
}

/**
 * How long rung 7 waits for the image after `capturePhoto` says the request was ACCEPTED.
 *
 * A Ray-Ban Meta JPEG round trip measures in the low seconds over the link — `WalkthroughRecorder`
 * budgets five for the same wait at the end of a walk — so this only ever elapses when the image is
 * genuinely never coming. Generous rather than tight on purpose: this rung's job is to MEASURE the
 * photo, and a timeout that fires on a slow-but-successful transfer would report a defect that does
 * not exist. What it must not do is leave the rung on "waiting" forever, with its button disabled
 * and no way back short of leaving the screen — the same dead end the `requested: false` branch
 * below already closes for the rejection case.
 */
const PHOTO_EVENT_TIMEOUT_MS = 15_000;

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
  /** The pending PHOTO_EVENT_TIMEOUT_MS timer, kept next to the subscription it races. */
  const photoTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPhotoTimeout = useCallback(() => {
    if (photoTimeout.current !== null) {
      clearTimeout(photoTimeout.current);
      photoTimeout.current = null;
    }
  }, []);

  useEffect(() => {
    photoSub.current = onPhoto((photo: PhotoMeasurement) => {
      // Cancel first: the image won, and a timer left running would overwrite a good measurement
      // with a failure fifteen seconds after it was already on screen.
      clearPhotoTimeout();
      setState((s) => ({ ...s, photo: "ok" }));
      setResult((r) => ({ ...r, photo: describePhoto(photo) }));
    });
    // Both halves torn down together — a timer that outlives this screen fires setState on an
    // unmounted component, and unlike the subscription nothing else would ever clear it.
    return () => {
      photoSub.current?.();
      clearPhotoTimeout();
    };
  }, [clearPhotoTimeout]);

  // The step that actually COMPLETES rung 3, and the one rung that had no owner.
  //
  // startRegistration() hands off to Meta AI, which returns on `trockcam://`. The SDK only
  // learns the outcome if that URL reaches handleUrl(). Nothing called it, and expo-router
  // claims incoming URLs for navigation, so the callback was consumed as a route and dropped.
  // Registration therefore never finished: deviceCount stayed 0 and every rung from 6 down
  // failed with "No eligible device available" — an error that names the glasses when the real
  // culprit was this missing line.
  //
  // This only covers a WARM return (app stayed alive while Meta AI was in front). A COLD return
  // — iOS terminated the app during the handoff — delivers the same URL as the app's *initial*
  // route instead of an event here, and that route is not this screen, so an effect scoped to
  // this screen would never mount to receive it. That case is handled once, unconditionally, in
  // the root layout (app/_layout.tsx) instead. This effect intentionally does not duplicate
  // Linking.getInitialURL() — that would call handleUrl() twice for the same launch.
  useEffect(() => {
    const handle = (url: string) => {
      setCallback(url);
      Wearables.handleUrl(url)
        .then((r) => setCallback(`${url}\nhandled: ${r.handled}`))
        .catch((e) => setCallback(`${url}\n${String(e)}`));
    };
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
    {
      key: "hfpWithStream",
      label: "9  Step 0 — HFP under a DAT stream",
      run: async () => {
        const check = await Wearables.checkHfpWithStream();
        const verdict = describeHfpStreamCheck(check);
        return { verdict: verdict.outcome.toUpperCase(), summary: verdict.summary, ...check };
      },
      measurement: true,
    },
    {
      key: "streamEndurance",
      label: "11 Does video survive 60s with NO audio?",
      run: async () => {
        const m = await Wearables.measureStreamWithoutAudio(60);
        // Frames stopping is the whole question, so say so plainly rather than making someone
        // read an array. The judgement itself lives in step0-verdicts alongside rungs 9 and 10,
        // which is where it can be unit-tested — it now has to weigh whether the run was a
        // no-audio measurement at all, and that is not a line of screen code.
        return { verdict: describeStreamEndurance(m), ...m };
      },
      measurement: true,
    },
    {
      key: "phoneAudioStream",
      label: "12 Glasses video + PHONE mic — 60s",
      run: async () => {
        const m = await Wearables.measureStreamWithPhoneAudio(60);
        const sustained = m.secondsToLastFrame >= m.secondsObserved - 3;
        const verdict =
          m.totalFrames === 0
            ? "NO FRAMES — the stream never delivered; says nothing about the pairing"
            : sustained
              ? `SUSTAINED ${m.secondsObserved}s on ${m.inputPortName} at `
                + `${m.negotiatedSampleRate} Hz — video AND audio are both viable, with better `
                + `audio than HFP's 16 kHz. Keep the video track.`
              : `STOPPED at ${m.secondsToLastFrame.toFixed(1)}s — the phone mic disturbs the `
                + `stream too, so video cannot coexist with any recording. Audio + stills.`;
        return { verdict, ...m };
      },
      measurement: true,
    },
    {
      key: "phoneCamera",
      label: "10 Step 0 — phone camera during HFP",
      run: async () => {
        const check = await Wearables.checkPhoneCameraDuringHfp();
        const verdict = describePhoneCameraCheck(check);
        return { verdict: verdict.outcome.toUpperCase(), summary: verdict.summary, ...check };
      },
      measurement: true,
    },
  ];

  const run = useCallback(async (rung: Rung) => {
    setState((s) => ({ ...s, [rung.key]: "running" }));
    setResult((r) => ({ ...r, [rung.key]: "" }));
    try {
      const value = await rung.run();
      // capturePhoto only reports whether the request was ACCEPTED. When accepted, the image
      // and its dimensions arrive later on the photo event, so this rung stays "running" until
      // onPhoto() resolves it above. When rejected (stream busy, or not ready), no photo event
      // ever follows — leaving the rung "running" forever, with its button disabled and no way
      // to retry short of leaving the screen — so that case must fail immediately instead.
      if (rung.key === "photo" && isCapturePhotoResult(value)) {
        if (!value.requested) {
          setState((s) => ({ ...s, photo: "fail" }));
          setResult((r) => ({
            ...r,
            photo: "request rejected — stream is busy or not ready. Retry once the stream is running.",
          }));
          return;
        }
        setResult((r) => ({ ...r, photo: "requested — waiting for image…" }));
        // An ACCEPTED request is not a delivered one. `capturePhoto` resolves the moment the SDK
        // takes the request; the image comes back later on the photo event, and when it never does
        // — the link drops, the glasses refuse mid-transfer — nothing else in this screen is
        // watching. Cancelled by the photo handler above on the way to "ok", so a real image is
        // never affected by this.
        clearPhotoTimeout(); // a re-run must not be failed by the previous attempt's timer
        photoTimeout.current = setTimeout(() => {
          photoTimeout.current = null;
          setState((s) => ({ ...s, photo: "fail" }));
          setResult((r) => ({
            ...r,
            photo:
              `accepted, then no image within ${PHOTO_EVENT_TIMEOUT_MS / 1000}s — the request `
              + "reached the glasses but nothing came back. Check the stream is still running "
              + "(rung 6) and retry.",
          }));
        }, PHOTO_EVENT_TIMEOUT_MS);
        return;
      }
      setState((s) => ({ ...s, [rung.key]: "ok" }));
      setResult((r) => ({ ...r, [rung.key]: JSON.stringify(value, null, 1) }));
    } catch (error) {
      setState((s) => ({ ...s, [rung.key]: "fail" }));
      setResult((r) => ({ ...r, [rung.key]: String(error) }));
    }
  }, [clearPhotoTimeout]);

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
        DAT stream starts, or the audio route fails silently. Rungs 7 and 8 are answered —
        see the file header. Rungs 9 and 10 are the open questions now, and each manages its
        own audio session and stream, so neither depends on the order above. Rung 9 still needs
        rung 1 run first this session; rung 10 needs only the glasses connected over Bluetooth.
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
