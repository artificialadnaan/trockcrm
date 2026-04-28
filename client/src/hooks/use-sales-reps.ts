import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface SalesRepOption {
  id: string;
  displayName: string;
}

export function useSalesReps() {
  const [salesReps, setSalesReps] = useState<SalesRepOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ users: SalesRepOption[] }>("/users/sales-reps");
      setSalesReps(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sales reps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { salesReps, loading, error, refetch: load };
}
