import { useEffect, useState } from "react";
import * as Location from "expo-location";

export type LocationStatus = "pending" | "granted" | "denied";

export type DeviceLocation = {
  /** The device's current coordinates, or null when permission was denied / no fix is available yet. */
  coords: { lat: number; lng: number } | null;
  status: LocationStatus;
};

/**
 * Foreground device location for the "nearby projects" feature, resolved ONCE on mount. Permission is
 * already declared in app.config.ts (the same `expo-location` the camera uses for photo geotagging), so
 * this adds no new native capability. It NEVER throws to the UI: a denied permission or missing fix
 * resolves to `coords: null`, which the projects screen treats as "hide the Nearby section" — no nagging,
 * no permission card. `getLastKnownPositionAsync` is tried first for an instant answer, falling back to a
 * fresh `getCurrentPositionAsync`.
 */
export function useDeviceLocation(): DeviceLocation {
  const [state, setState] = useState<DeviceLocation>({ coords: null, status: "pending" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== "granted") {
          setState({ coords: null, status: "denied" });
          return;
        }
        const position =
          (await Location.getLastKnownPositionAsync()) ??
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
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
