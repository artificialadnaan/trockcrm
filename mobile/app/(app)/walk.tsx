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
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { theme } from "../../src/theme/theme";
import { canCapture } from "../../src/walkthrough/session";
import { useWalk } from "../../src/walkthrough/useWalk";

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
  // proven to attach a capture to the right deal.
  const params = useLocalSearchParams<{
    dealId?: string;
    targetName?: string;
    projectId?: string;
  }>();
  const router = useRouter();

  const dealId = typeof params.dealId === "string" ? params.dealId : "";
  const projectId = typeof params.projectId === "string" && params.projectId ? params.projectId : null;
  const targetName = typeof params.targetName === "string" && params.targetName ? params.targetName : "this project";

  const { walk, error, start, capture, end, stillCount, bridgeAvailable } = useWalk(dealId, projectId);

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

  const captureEnabled = canCapture(walk);
  const elapsedMs = walk.startedAt !== null ? Math.max(0, now - walk.startedAt) : 0;

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

            {/* The one control this screen is built around: huge, centered, impossible to miss
                even gloved and one-handed. Disabled — not merely unresponsive — the moment
                canCapture(walk) goes false, so a tap can never be silently swallowed. */}
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
    fontFamily: "Menlo",
  },

  pressed: { opacity: 0.8 },
});
