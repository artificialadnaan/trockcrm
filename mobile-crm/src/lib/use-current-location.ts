import { useCallback, useState } from "react";
import * as Location from "expo-location";

/**
 * Where the rep is standing — and every way that can fail.
 *
 * The capture screen uses this to answer "which building is this?", so the states below are not error
 * handling bolted on afterwards: each one is a different thing the screen has to SAY. Collapsing them
 * into a boolean produces the classic field-app failure, a spinner that never resolves and no
 * explanation, on a phone held by someone who cannot go and check a settings screen right now.
 *
 *   idle       — not asked yet
 *   locating   — permission granted, waiting on a fix
 *   ready      — we have a position
 *   denied     — the OS said no. Recoverable ONLY in Settings, so the screen must say that rather than
 *                offer a retry button that will never work.
 *   unavailable— services are off device-wide, or the fix timed out / errored. A retry is meaningful.
 *
 * `denied` and `unavailable` are deliberately distinct: retrying a denied permission silently does
 * nothing, which reads as a broken button.
 */
export type LocationState =
  | { status: "idle" }
  | { status: "locating" }
  | { status: "ready"; lat: number; lng: number; accuracyMeters: number | null }
  | { status: "denied" }
  | { status: "unavailable"; reason: string };

/**
 * Balanced, not Highest.
 *
 * Highest keeps the GPS radio hot for several extra seconds to refine a fix well below the ~200 m the
 * property matcher works at — spending battery, on a phone that is out all day, for precision this
 * feature discards. Balanced typically resolves in a second or two.
 */
const ACCURACY = Location.Accuracy.Balanced;

/** Past this, the fix covers a city block and "the building you're at" is a guess worth flagging. */
export const COARSE_ACCURACY_METERS = 100;

export function useCurrentLocation() {
  const [state, setState] = useState<LocationState>({ status: "idle" });

  const locate = useCallback(async () => {
    setState({ status: "locating" });
    try {
      // Services BEFORE permission: with location off device-wide, requesting permission can resolve
      // "granted" and then never produce a fix — a granted permission and a permanent spinner.
      const enabled = await Location.hasServicesEnabledAsync();
      if (!enabled) {
        setState({ status: "unavailable", reason: "Location services are off for this phone." });
        return;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) {
        setState({ status: "denied" });
        return;
      }

      const position = await Location.getCurrentPositionAsync({ accuracy: ACCURACY });
      const { latitude, longitude, accuracy } = position.coords;
      // A fix can come back as NaN on a cold start. Validated here rather than passed to the matcher,
      // where a NaN silently degrades a "which building?" query into an address-only one with no
      // indication that the position was ever lost.
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        setState({ status: "unavailable", reason: "Couldn't get a usable position." });
        return;
      }
      setState({
        status: "ready",
        lat: latitude,
        lng: longitude,
        accuracyMeters: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
      });
    } catch (err) {
      setState({
        status: "unavailable",
        reason: err instanceof Error ? err.message : "Couldn't get your location.",
      });
    }
  }, []);

  /** Back to idle, so the screen can offer the manual path without the stale failure still on show. */
  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, locate, reset };
}
