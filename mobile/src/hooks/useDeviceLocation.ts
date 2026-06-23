import { useCallback, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Location from "expo-location";

export type LocationStatus = "pending" | "granted" | "denied";

export type DeviceLocation = {
  /** The device's current coordinates, or null when permission was denied / no fix is available yet. */
  coords: { lat: number; lng: number } | null;
  status: LocationStatus;
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
 * A `getLastKnownPositionAsync` answer is used only when recent enough; otherwise a fresh
 * `getCurrentPositionAsync` is fetched so the "nearby" sort reflects where the user actually is.
 */
export function useDeviceLocation(): DeviceLocation {
  const [state, setState] = useState<DeviceLocation>({ coords: null, status: "pending" });

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const resolve = async () => {
        try {
          // getForegroundPermissionsAsync() reports status WITHOUT prompting — we never proactively ask.
          const { status } = await Location.getForegroundPermissionsAsync();
          if (cancelled) return;
          if (status !== "granted") {
            setState({ coords: null, status: status === "denied" ? "denied" : "pending" });
            return;
          }
          const position =
            (await Location.getLastKnownPositionAsync({ maxAge: MAX_LAST_KNOWN_AGE_MS })) ??
            (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
          if (cancelled) return;
          setState(
            position
              ? { coords: { lat: position.coords.latitude, lng: position.coords.longitude }, status: "granted" }
              : { coords: null, status: "granted" },
          );
        } catch {
          if (!cancelled) setState({ coords: null, status: "denied" });
        }
      };

      void resolve();
      const sub = AppState.addEventListener("change", (next) => {
        if (next === "active") void resolve();
      });
      return () => {
        cancelled = true;
        sub.remove();
      };
    }, []),
  );

  return state;
}
