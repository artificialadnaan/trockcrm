/**
 * Pairing display state for the glasses row.
 *
 * "Glasses not working" collapses four situations that each need a different instruction:
 * the native module is missing (rebuild the app), the SDK was never configured (a code/config
 * bug, not a user action), nothing is registered (pair the glasses), or a registered device is
 * not currently reachable (put the glasses on / check Bluetooth — pairing again would be wrong,
 * they already did it). Telling someone to pair glasses they paired last week sends them through
 * a flow that tells them it is already done — a two-minute fix turned into an evening.
 *
 * Branch order is the whole point: bridge → configured → registration → link → ready. Each
 * check assumes every prior one already passed, so reordering silently changes which message a
 * real input produces.
 */

export type PairingStatus =
  | "unavailable"
  | "unconfigured"
  | "unpaired"
  | "disconnected"
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

  return {
    status: "ready",
    label: "Glasses ready",
    detail: `${input.deviceName ?? "Your glasses"} is connected and ready to record.`,
    canStartWalk: true,
  };
}
