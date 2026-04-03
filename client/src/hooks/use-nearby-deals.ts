import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface NearbyDeal {
  id: string;
  dealNumber: string;
  name: string;
  propertyCity: string | null;
  distance: number; // miles
}

export function useNearbyDeals() {
  const [deals, setDeals] = useState<NearbyDeal[]>([]);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError("Geolocation not supported by this browser");
      setLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude: lat, longitude: lng } = pos.coords;
          const data = await api<{ deals: NearbyDeal[] }>(
            `/deals/nearby?lat=${lat}&lng=${lng}`
          );
          setDeals(data.deals);
        } catch (err) {
          console.error("Failed to fetch nearby deals:", err);
        } finally {
          setLoading(false);
        }
      },
      (err) => {
        setGpsError(err.message);
        setLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  // Auto-select: nearest deal within 200m (~0.124 miles)
  const autoSelectedDeal =
    deals.length > 0 && deals[0].distance < 0.124 ? deals[0] : null;

  return { deals, autoSelectedDeal, gpsError, loading };
}
