/**
 * Pairing display state for the glasses row.
 *
 * "Glasses not working" collapses five situations that each need a different instruction:
 * the native module is missing (rebuild the app), the SDK was never configured (a code/config
 * bug, not a user action), nothing is registered (pair the glasses), a registered device is
 * not currently reachable (put the glasses on / check Bluetooth — pairing again would be wrong,
 * they already did it), or a reachable device is missing Meta's SEPARATE camera authorization
 * (grant camera access — a completely different action from any of the above). Telling someone
 * to pair glasses they paired last week sends them through a flow that tells them it is already
 * done — a two-minute fix turned into an evening.
 *
 * Branch order is the whole point: bridge → configured → registration → link → camera permission →
 * ready. Each check assumes every prior one already passed, so reordering silently changes which
 * message a real input produces. Camera permission is checked LAST, right before "ready", because
 * it is only a meaningful question once a device is actually registered AND reachable — a
 * permission prompt for a device that isn't even linked yet would be premature and would test
 * nothing the user could act on.
 */

export type PairingStatus =
  | "unavailable"
  | "unconfigured"
  | "unpaired"
  | "disconnected"
  | "cameraBlocked"
  | "ready";

export type PairingInput = {
  /** Whether the WearablesBridge native module exists in this build at all. */
  bridgeAvailable: boolean;
  /** Whether `Wearables.configure()` has succeeded this session. */
  configured: boolean;
  /** Raw SDK registration state, e.g. "registered" | "available". */
  registrationState: string;
  deviceCount: number;
  deviceName: string | null;
  /** DAT link state for the active device, e.g. "connected" | "disconnected". Null if none active. */
  linkState: string | null;
  /**
   * Raw `Diagnosis.cameraPermission` from `Wearables.diagnose()` — MWDATCore's `PermissionStatus`
   * has exactly two real cases, `"granted"` and `"denied"` (native's `String(describing:)` of the
   * Swift enum), or an `"error: ..."` string if the check itself threw. Null before it's ever been
   * read (bridge unavailable, or diagnose() hasn't resolved yet). Anything other than the literal
   * string `"granted"` is treated as NOT granted — this must never default-assume access, since a
   * registered, connected device with no camera authorization cannot start a stream at all.
   */
  cameraPermission: string | null;
};

export type Pairing = {
  status: PairingStatus;
  label: string;
  detail: string;
  /** Whether a walk can be started right now, given this pairing state. */
  canStartWalk: boolean;
};

export function describePairing(input: PairingInput): Pairing {
  if (!input.bridgeAvailable) {
    return {
      status: "unavailable",
      label: "Glasses unavailable",
      detail: "This build predates the glasses recorder. Rebuild the dev client to enable it.",
      canStartWalk: false,
    };
  }

  if (!input.configured) {
    return {
      status: "unconfigured",
      label: "Glasses not configured",
      detail: "The glasses SDK has not been configured yet. Restart the app and try again.",
      canStartWalk: false,
    };
  }

  if (input.registrationState !== "registered" || input.deviceCount === 0) {
    return {
      status: "unpaired",
      label: "No glasses paired",
      detail: "Pair your Meta Ray-Ban glasses in the Meta AI app, then come back here.",
      canStartWalk: false,
    };
  }

  if (input.linkState !== "connected") {
    return {
      status: "disconnected",
      label: "Glasses not reachable",
      detail: "Your glasses are registered but not reachable right now. Put them on and check Bluetooth.",
      canStartWalk: false,
    };
  }

  // A registered, connected device is not enough: the recorder needs Meta's SEPARATE camera
  // authorization (Wearables.diagnose()'s cameraPermission), and there is no build-time guarantee
  // it was ever granted — only "granted" counts as granted, so a denial, an unread/null value, or
  // an error checking it all land here rather than silently falling through to "ready".
  if (input.cameraPermission !== "granted") {
    return {
      status: "cameraBlocked",
      label: "Camera access needed",
      detail: `${input.deviceName ?? "Your glasses"} is connected, but this app doesn't have camera access for it yet.`,
      canStartWalk: false,
    };
  }

  return {
    status: "ready",
    label: "Glasses ready",
    detail: `${input.deviceName ?? "Your glasses"} is connected and ready to record.`,
    canStartWalk: true,
  };
}
