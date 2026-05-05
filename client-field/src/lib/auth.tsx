import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";

export type FieldUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: "field_contractor";
  tenantId: string;
  active: boolean;
};

type AuthState = {
  user: FieldUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  acceptInvite: (token: string, password: string) => Promise<void>;
  previewInvite: (token: string) => Promise<{ firstName: string; lastName: string; email: string }>;
  logout: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

function assertFieldUser(user: FieldUser | null | undefined): FieldUser {
  if (
    !user ||
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    user.role !== "field_contractor" ||
    typeof user.tenantId !== "string" ||
    typeof user.active !== "boolean"
  ) {
    throw new ApiError("Server returned malformed user data", 500);
  }
  return user;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<FieldUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ user: FieldUser }>("/field/me")
      .then((payload) => {
        if (!cancelled) setUser(assertFieldUser(payload.user));
      })
      .catch((err) => {
        if (!cancelled && err instanceof ApiError && err.status !== 401) {
          setError(err.message);
        }
        if (!cancelled) clearSession();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    const payload = await api<{ user: FieldUser }>("/auth/field-login", {
      method: "POST",
      json: { email, password },
    });
    setUser(assertFieldUser(payload.user));
  }, []);

  const acceptInvite = useCallback(async (token: string, password: string) => {
    setError(null);
    const payload = await api<{ user: FieldUser }>("/auth/accept-invite", {
      method: "POST",
      json: { token, password },
    });
    setUser(assertFieldUser(payload.user));
  }, []);

  const previewInvite = useCallback((token: string) => (
    api<{ firstName: string; lastName: string; email: string }>(`/auth/invite-preview?token=${encodeURIComponent(token)}`)
  ), []);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo<AuthState>(() => ({
    user,
    loading,
    error,
    login,
    acceptInvite,
    previewInvite,
    logout,
    clearError: () => setError(null),
  }), [acceptInvite, error, loading, login, logout, previewInvite, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
