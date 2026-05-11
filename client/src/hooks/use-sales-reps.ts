import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface SalesRepOption {
  id: string;
  displayName: string;
  email?: string | null;
}

export function useSalesReps(officeId?: string) {
  const [salesReps, setSalesReps] = useState<SalesRepOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = officeId && officeId !== "all"
        ? { "x-office-id": officeId }
        : undefined;
      const data = await api<{ users: SalesRepOption[] }>("/users/sales-reps", headers ? { headers } : undefined);
      setSalesReps(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sales reps");
    } finally {
      setLoading(false);
    }
  }, [officeId]);

  useEffect(() => {
    load();
  }, [load]);

  return { salesReps, loading, error, refetch: load };
}
