import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { api } from "./api";

interface User {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "sales_manager" | "rep" | "construction";
  officeId: string;
  activeOfficeId?: string;
  mustChangePassword?: boolean;
  onboardingCompletedAt?: string | null;
  onboardingPendingCount?: number;
  requiresOnboarding?: boolean;
  cleanupUrl?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, returnTo?: string | null) => Promise<{ returnTo?: string | null; mustChangePassword?: boolean }>;
  localLogin: (email: string, password: string, returnTo?: string | null) => Promise<{ returnTo?: string | null; mustChangePassword?: boolean }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const data = await api<{ user: User }>("/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = async (email: string, returnTo?: string | null) => {
    const data = await api<{ user: User; returnTo?: string | null }>("/auth/dev/login", {
      method: "POST",
      json: { email, returnTo },
    });
    if (!data.returnTo) setUser(data.user);
    return { returnTo: data.returnTo };
  };

  const localLogin = async (email: string, password: string, returnTo?: string | null) => {
    const data = await api<{ user: User; returnTo?: string | null }>("/auth/local/login", {
      method: "POST",
      json: { email, password, returnTo },
    });
    setUser(data.user);
    return { returnTo: data.returnTo, mustChangePassword: Boolean(data.user.mustChangePassword) };
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    const data = await api<{ user: User }>("/auth/local/change-password", {
      method: "POST",
      json: { currentPassword, newPassword },
    });
    setUser(data.user);
  };

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.location.assign("/login?loggedOut=1");
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        localLogin,
        changePassword,
        logout,
        refreshUser: fetchUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
