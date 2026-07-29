import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/**
 * A tap you can feel, for the three moments that commit something.
 *
 * The stated user is holding the phone in a gloved hand, outdoors, often next to running equipment.
 * Every write in this app lands silently: a capture saves, a stage moves, a duplicate halts, and the
 * only signal is a box appearing somewhere on screen. On a jobsite that is the weakest channel
 * available, and it is the one the app was using exclusively.
 *
 * WRAPPED rather than called directly, for two reasons that have both bitten this codebase:
 *
 * Haptics REJECT on a device without a taptic engine, and an unhandled rejection from a feedback call
 * would take down the save handler it was decorating. Feedback failing is not an error worth
 * propagating — the write already succeeded.
 *
 * And the platform check is here rather than at each call site. iOS is the only platform this app
 * builds for today, but a `Platform.OS` test copied to five call sites is five places to forget one.
 */

function fire(run: () => Promise<void>): void {
  if (Platform.OS !== "ios") return;
  // Deliberately not awaited: the caller is committing a write and must not wait on a vibration.
  void run().catch(() => {
    // No taptic engine, or the OS declined. Nothing to recover and nothing to report.
  });
}

/** A write landed. The single most useful one — "it saved" without reading anything. */
export function hapticSuccess(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/**
 * The app is asking something before it will proceed — a duplicate to resolve, a gate unmet.
 *
 * WARNING rather than ERROR: nothing has gone wrong and nothing was lost. The rep tapped Save and the
 * app needs an answer first, which is a different feeling from a failed write and should not be given
 * the same one.
 */
export function hapticNeedsAnswer(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** A write failed, or came back indeterminate. */
export function hapticFailure(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}
