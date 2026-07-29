import { useCallback, useRef, useState } from "react";
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

/**
 * How long to wait for a fix before giving the rep their controls back.
 *
 * getCurrentPositionAsync has no application-level deadline: with services on and permission granted
 * but no reception — indoors, in a stairwell, in a basement — it simply does not resolve. The screen
 * replaces the retry AND the company fallback with a spinner for the whole native wait, so the one
 * state a rep cannot escape is the one they hit inside the building they are trying to log.
 */
export const LOCATION_FIX_TIMEOUT_MS = 12_000;

export function useCurrentLocation() {
  const [state, setState] = useState<LocationState>({ status: "idle" });
  /**
   * Which attempt is current.
   *
   * Stamped at the START of locate(), not before the fix: every step here is async, so a rep who taps
   * "Try again" during the permission prompt has two attempts in flight through all of them.
   */
  const locateGeneration = useRef(0);

  const locate = useCallback(async () => {
    const generation = ++locateGeneration.current;
    const superseded = () => generation !== locateGeneration.current;
    setState({ status: "locating" });
    try {
      // Services BEFORE permission: with location off device-wide, requesting permission can resolve
      // "granted" and then never produce a fix — a granted permission and a permanent spinner.
      const enabled = await Location.hasServicesEnabledAsync();
      if (superseded()) return;
      if (!enabled) {
        setState({ status: "unavailable", reason: "Location services are off for this phone." });
        return;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (superseded()) return;
      if (status !== Location.PermissionStatus.GRANTED) {
        setState({ status: "denied" });
        return;
      }

      /**
       * The deadline abandons the WAIT; it cannot cancel the native request.
       *
       * expo-location's getCurrentPositionAsync takes no signal, so the OS keeps looking and may
       * resolve minutes later — by which time the rep has retried, or moved, or attached the visit to
       * a company. A generation stamp makes that harmless: a result from a superseded attempt is
       * discarded rather than applied, so a late fix can never overwrite a newer one or reanimate a
       * screen the rep has already moved past. Overlapping native work is the cost of an API with no
       * cancellation; corrupting state with it is not.
       */
      let timer: ReturnType<typeof setTimeout> | undefined;
      const position = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: ACCURACY }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("LOCATION_TIMEOUT")), LOCATION_FIX_TIMEOUT_MS);
        }),
      ]).finally(() => {
        // Without this the timer holds a pending rejection for its full duration after a fast fix.
        if (timer) clearTimeout(timer);
      });
      if (superseded()) return;
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
      const timedOut = err instanceof Error && err.message === "LOCATION_TIMEOUT";
      // A superseded attempt reports nothing — including its timeout. Otherwise the FIRST attempt's
      // deadline lands on top of a retry that is still running and tells the rep it failed.
      if (superseded()) return;
      setState({
        status: "unavailable",
        reason: timedOut
          ? "Couldn't get a fix — you may be inside. Try again, or attach this to a company."
          : err instanceof Error
            ? err.message
            : "Couldn't get your location.",
      });
    }
  }, []);

  /**
   * Back to idle — and the attempt in flight is ABANDONED, not merely hidden.
   *
   * Bumping the generation is the load-bearing half. Without it `reset()` only repainted: a `locate()`
   * still running passed every `superseded()` check and, seconds later, set `ready` or `unavailable`
   * over the top. On the capture screen that is not cosmetic — a late `ready` starts the match lookup,
   * which blocks Save and clears the company the rep just chose instead.
   *
   * This was harmless while the only caller was "Change property", which runs when no fix is in flight.
   * The moment the escape hatch became reachable DURING `locating`, the race became reachable with it.
   */
  const reset = useCallback(() => {
    locateGeneration.current++;
    setState({ status: "idle" });
  }, []);

  return { state, locate, reset };
}
