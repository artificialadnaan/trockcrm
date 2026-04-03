import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface NearbyDeal {
  id: string;
  dealNumber: string;
  name: string;
  propertyCity: string | null;
  distance: number; // miles, -1 if GPS not available
}

/**
 * Fetch deals sorted by GPS distance when available,
 * falling back to all active deals alphabetically.
 */
export function useNearbyDeals() {
  const [deals, setDeals] = useState<NearbyDeal[]>([]);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchDeals() {
      // Try GPS first
      let nearbyDeals: NearbyDeal[] = [];
      let gpsOk = false;

      if (navigator.geolocation) {
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 10000,
            });
          });

          const { latitude: lat, longitude: lng } = pos.coords;
          const data = await api<{ deals: NearbyDeal[] }>(
            `/deals/nearby?lat=${lat}&lng=${lng}`
          );
          nearbyDeals = data.deals;
          gpsOk = true;
        } catch (err) {
          const msg = err instanceof GeolocationPositionError ? err.message : "GPS unavailable";
          setGpsError(msg);
        }
      } else {
        setGpsError("Geolocation not supported");
      }

      // If GPS worked and returned results, use those
      if (gpsOk && nearbyDeals.length > 0) {
        if (!cancelled) {
          setDeals(nearbyDeals);
          setLoading(false);
        }
        return;
      }

      // Fallback: fetch all active deals alphabetically
      try {
        const data = await api<{
          deals: Array<{ id: string; dealNumber: string; name: string; propertyCity: string | null }>;
        }>("/deals?limit=100&sortBy=name&sortDir=asc&isActive=true");
        if (!cancelled) {
          setDeals(
            data.deals.map((d) => ({ ...d, distance: -1 }))
          );
        }
      } catch (err) {
        console.error("Failed to fetch deals:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDeals();
    return () => { cancelled = true; };
  }, []);

  // Auto-select: nearest deal within 200m (~0.124 miles)
  const autoSelectedDeal =
    deals.length > 0 && deals[0].distance >= 0 && deals[0].distance < 0.124
      ? deals[0]
      : null;

  return { deals, autoSelectedDeal, gpsError, loading };
}
