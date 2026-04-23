import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface AccessibleOffice {
  id: string;
  name: string;
  slug: string;
}

export function useAccessibleOffices() {
  const [offices, setOffices] = useState<AccessibleOffice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ offices: AccessibleOffice[] }>("/auth/accessible-offices");
      setOffices(data.offices);
    } catch {
      setError("Failed to load accessible offices");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return { offices, loading, error, refetch: load };
}
