import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

interface GraphAuthStatus {
  connected: boolean;
  status: string | null;
  errorMessage: string | null;
}

export function useGraphAuth() {
  const [authStatus, setAuthStatus] = useState<GraphAuthStatus>({
    connected: false,
    status: null,
    errorMessage: null,
  });
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<GraphAuthStatus>("/auth/graph/status");
      setAuthStatus(data);
    } catch {
      // If endpoint fails, assume not connected
      setAuthStatus({ connected: false, status: null, errorMessage: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const startConsent = useCallback(async () => {
    try {
      const data = await api<{ url: string | null; devMode?: boolean }>("/auth/graph/consent");
      if (data.devMode) {
        // Dev mode: mark as connected without redirect
        setAuthStatus({ connected: true, status: "active", errorMessage: null });
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: unknown) {
      console.error("Failed to start Graph consent:", err);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await api("/auth/graph/disconnect", { method: "POST" });
      setAuthStatus({ connected: false, status: "revoked", errorMessage: null });
    } catch (err: unknown) {
      console.error("Failed to disconnect Graph:", err);
    }
  }, []);

  return {
    ...authStatus,
    loading,
    startConsent,
    disconnect,
    refetch: fetchStatus,
  };
}
