import { useState, useEffect } from "react";
import { api } from "@/lib/api";

export interface Office {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
}

export function useAdminOffices() {
  const [offices, setOffices] = useState<Office[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ offices: Office[] }>("/admin/offices");
      setOffices(data.offices);
    } catch {
      setError("Failed to load offices");
    } finally {
      setLoading(false);
    }
  };

  const createOffice = async (input: { name: string; slug: string; address?: string; phone?: string }) => {
    const data = await api<{ office: Office }>("/admin/offices", {
      method: "POST",
      json: input,
    });
    await load();
    return data.office;
  };

  const updateOffice = async (id: string, input: Partial<Office>) => {
    await api(`/admin/offices/${id}`, {
      method: "PATCH",
      json: input,
    });
    await load();
  };

  useEffect(() => { load(); }, []);
  return { offices, loading, error, refetch: load, createOffice, updateOffice };
}
