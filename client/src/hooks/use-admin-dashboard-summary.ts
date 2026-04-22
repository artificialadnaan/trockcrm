import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AdminDashboardSummary } from "@/lib/admin-dashboard-summary";

export function useAdminDashboardSummary() {
  const [data, setData] = useState<AdminDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void api<{ data: AdminDashboardSummary }>("/dashboard/admin")
      .then((result) => setData(result.data))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load admin dashboard"))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
