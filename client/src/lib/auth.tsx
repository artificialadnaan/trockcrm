import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { api, clearCsrfTokenOverride } from "./api";

type Role = "admin" | "director" | "sales_manager" | "rep" | "construction";

interface User {
  id: string;
  email: string;
  displayName: string;
  /** Effective role for the active office (may be elevated by a per-office role_override). */
  role: Role;
  /**
   * HOME role from users.role — NOT office-override-elevated. Source of truth for GLOBAL-admin gating
   * (the server gates user-provisioning on the base role). From /api/auth/me; absent right after login
   * (when effective role == base anyway), so consumers fall back to `role` via isGlobalAdmin().
   */
  baseRole?: Role;
  officeId: string;
  activeOfficeId?: string;
  mustChangePassword?: boolean;
  onboardingCompletedAt?: string | null;
  onboardingPendingCount?: number;
  requiresOnboarding?: boolean;
  cleanupUrl?: string;
  /** True iff this user may review declined RFPs (Takashi/Adam allowlist); gates the /rfp-review page. */
  isRfpReviewer?: boolean;
  /** True iff this user is one of the 3 RFP voters (Sidney/Tim/James); gates the vote UI + /rfp-vote page. */
  isRfpVoter?: boolean;
  /**
   * True iff this user may open the Daily Activity Log; hides the report card + blocks the route. The server
   * enforces the same allowlist on the endpoint, so treating a missing flag as "no" only hides a surface that
   * would have 403'd anyway.
   */
  canViewDailyActivityLog?: boolean;
  /**
   * True iff this user may open the Canvassing Activity report; hides the card + blocks the route. The
   * server enforces the same allowlist, so treating a missing flag as "no" only hides a dead link.
   */
  canViewCanvassingReport?: boolean;
  /**
   * True iff this user may move a deal back to Opportunity. Hides the menu item; the server enforces the
   * same allowlist, so treating a missing flag as "no" only hides an action that would have 403'd.
   */
  canMoveDealBackToOpportunity?: boolean;
  /**
   * True iff this person has a task assignment the new-assignment modal has not shown them yet (or an
   * urgent/high/overdue one that re-shows until it leaves `pending`). Drives <TaskAssignmentModal/>.
   *
   * It rides EVERY auth response — dev login, local login, mobile login, /auth/me and, critically,
   * /local/change-password — because `localLogin` sets `user` in place and never refetches /auth/me,
   * and a newly provisioned person is held on the force-password-change screen until that last one
   * answers. A flag present only on /auth/me is invisible on the login it is about.
   */
  hasPendingTaskAssignments?: boolean;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /**
   * A successful interactive authentication gets a new token. The task-assignment modal uses it to
   * forget the previous login's temporary "shown" set for this person. `/auth/me` deliberately does
   * not advance it: restoring a cookie-backed session on F5 is not another login.
   */
  assignmentModalSession: number;
  /** True until the modal has applied the reset for `assignmentModalSession`. */
  assignmentModalSessionResetPending: boolean;
  consumeAssignmentModalSessionReset: (session: number) => void;
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
  const [assignmentModalSession, setAssignmentModalSession] = useState({ token: 0, resetPending: false });

  // Only an affirmative web-auth action starts a new modal session. `fetchUser` runs on boot and on
  // refreshUser(), so advancing this from every setUser would turn an ordinary F5 into a fresh login
  // and re-open urgent repeats forever.
  const beginAssignmentModalSession = useCallback(() => {
    setAssignmentModalSession((current) => ({ token: current.token + 1, resetPending: true }));
  }, []);

  const consumeAssignmentModalSessionReset = useCallback((token: number) => {
    setAssignmentModalSession((current) =>
      current.token === token && current.resetPending ? { ...current, resetPending: false } : current
    );
  }, []);

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
    beginAssignmentModalSession();
    if (!data.returnTo) setUser(data.user);
    return { returnTo: data.returnTo };
  };

  const localLogin = async (email: string, password: string, returnTo?: string | null) => {
    const data = await api<{ user: User; returnTo?: string | null }>("/auth/local/login", {
      method: "POST",
      json: { email, password, returnTo },
    });
    beginAssignmentModalSession();
    setUser(data.user);
    return { returnTo: data.returnTo, mustChangePassword: Boolean(data.user.mustChangePassword) };
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    const data = await api<{ user: User }>("/auth/local/change-password", {
      method: "POST",
      json: { currentPassword, newPassword },
    });
    beginAssignmentModalSession();
    setUser(data.user);
  };

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    clearCsrfTokenOverride();
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
        assignmentModalSession: assignmentModalSession.token,
        assignmentModalSessionResetPending: assignmentModalSession.resetPending,
        consumeAssignmentModalSessionReset,
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
