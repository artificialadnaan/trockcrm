import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Location from "expo-location";

export type LocationStatus = "pending" | "granted" | "denied";

export type DeviceLocation = {
  /** The device's current coordinates, or null when permission was denied / no fix is available yet. */
  coords: { lat: number; lng: number } | null;
  status: LocationStatus;
  /**
   * Re-acquire a FRESH fix right now (bypassing the cached last-known position) — for an explicit user
   * gesture like pull-to-refresh, so a crew that drove to a new site while keeping this screen open gets
   * Nearby re-ranked around where they actually are.
   */
  refresh: () => void;
};

// A last-known fix older than this is treated as too stale for a "right now / nearby" sort — we fetch a
// fresh position instead, so a user who last opened the app in another city isn't ranked around it.
const MAX_LAST_KNOWN_AGE_MS = 5 * 60 * 1000;

/**
 * Foreground device location for the "nearby projects" feature, re-resolved every time the screen
 * gains focus.
 *
 * It deliberately NEVER raises the OS permission dialog: it only *checks* the current permission
 * (`getForegroundPermissionsAsync`, which does not prompt) and reads a position when it's ALREADY
 * granted. The location grant is owned by the photo-capture flow, which requests it with a clear
 * geotagging justification — so on this camera-first app permission is granted early through normal use,
 * and Nearby then lights up with no nagging and no permission card (per the approved design). When
 * permission is undetermined or denied, or there's no fix, this resolves to `coords: null` and the
 * projects screen simply hides the Nearby section. Never throws to the UI.
 *
 * It re-resolves rather than running once on mount because the tab shell keeps the Projects screen
 * mounted, and permission can change AFTER the first check:
 *   - via `useFocusEffect` — focusing back here (e.g. after granting location during photo capture on
 *     another tab) re-checks the now-granted permission; and
 *   - via an `AppState` "active" listener (registered only while focused) — covers granting location in
 *     iOS Settings while the app is backgrounded and the Projects tab is already focused, where no focus
 *     change fires on return.
 * Either way Nearby appears with no remount/restart.
 *
 * On focus/foreground a recent-enough `getLastKnownPositionAsync` answer is used for an instant result
 * (else a fresh `getCurrentPositionAsync`); `refresh()` always forces a fresh `getCurrentPositionAsync`.
 */
export function useDeviceLocation(): DeviceLocation {
  const [state, setState] = useState<{ coords: { lat: number; lng: number } | null; status: LocationStatus }>({
    coords: null,
    status: "pending",
  });
  // Guards against a late async resolve setting state after the screen has fully unmounted.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Monotonic request counter: a focus/foreground resolve(false) and a manual resolve(true) can be
  // in-flight at once, and a slower older one must NOT clobber the newer fix. Each call claims the next
  // seq and only commits if it's still the latest.
  const requestSeq = useRef(0);

  const resolve = useCallback(async (fresh: boolean) => {
    const seq = ++requestSeq.current;
    const commit = (next: { coords: { lat: number; lng: number } | null; status: LocationStatus }) => {
      if (mounted.current && seq === requestSeq.current) setState(next);
    };
    try {
      // getForegroundPermissionsAsync() reports status WITHOUT prompting — we never proactively ask.
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        commit({ coords: null, status: status === "denied" ? "denied" : "pending" });
        return;
      }
      // `fresh` (explicit refresh) always gets a current fix; the passive focus/foreground path may use a
      // recent last-known position for an instant answer.
      const position = fresh
        ? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        : ((await Location.getLastKnownPositionAsync({ maxAge: MAX_LAST_KNOWN_AGE_MS })) ??
          (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })));
      commit(
        position
          ? { coords: { lat: position.coords.latitude, lng: position.coords.longitude }, status: "granted" }
          : { coords: null, status: "granted" },
      );
    } catch {
      // A thrown error here is a transient GPS/provider failure (or a permissions-API hiccup), NOT a
      // denial — actual denial is handled by the status !== "granted" branch above. Don't misreport it as
      // "denied"; leave status unresolved ("pending"). Either way coords is null, so Nearby simply stays
      // hidden and a later focus/foreground/refresh re-resolve can recover.
      commit({ coords: null, status: "pending" });
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void resolve(false);
      const sub = AppState.addEventListener("change", (next) => {
        if (next === "active") void resolve(false);
      });
      return () => sub.remove();
    }, [resolve]),
  );

  const refresh = useCallback(() => void resolve(true), [resolve]);
  return { coords: state.coords, status: state.status, refresh };
}
