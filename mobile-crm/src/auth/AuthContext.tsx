import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, ApiError, type ApiFetchOptions } from "../api/client";
import * as authApi from "../api/endpoints/auth";
import { clearSession, isAllowedRole, loadSession, saveSession, type Session } from "./session";
import type { CrmUser } from "../api/types";

type AuthState = {
  /** Null once restore has finished and there is no session. `undefined` means "still restoring". */
  session: Session | null | undefined;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setActiveOffice: (officeId: string | null) => Promise<void>;
  /** A ready-to-use fetcher carrying the current token + active office. */
  fetcher: authApi.Fetcher;
};

const AuthContext = createContext<AuthState | null>(null);

/**
 * Thrown when credentials are valid but the account may not use this app. Kept distinct from ApiError so
 * the login screen can explain *why* rather than showing a generic failure.
 */
export class RoleNotAllowedError extends Error {
  constructor() {
    super("This account cannot sign in to the CRM app.");
    this.name = "RoleNotAllowedError";
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  // Held in a ref as well as state so `fetcher` stays referentially stable: rebuilding it on every token
  // change would invalidate every TanStack Query key that closes over it and refetch the whole app.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session ?? null;

  const signOut = useCallback(async () => {
    sessionRef.current = null;
    setSession(null);
    await clearSession();
  }, []);

  const fetcher = useCallback(
    <T,>(path: string, opts: ApiFetchOptions = {}) => {
      const current = sessionRef.current;
      return apiFetch<T>(path, {
        token: current?.token ?? null,
        officeId: current?.activeOfficeId ?? current?.user.officeId ?? null,
        // Only a 401 tears down the session — see the client's onUnauthorized doc. A 403 is an
        // authorization failure on one action and must NOT sign the user out.
        onUnauthorized: () => {
          void signOut();
        },
        ...opts,
      });
    },
    [signOut],
  );

  // Restore on launch, then revalidate against the server. The stored token's own `exp` is checked
  // locally first (cheap, offline-safe); /auth/me is what catches a deactivated user, a bumped
  // token_version, or a role change — none of which a stored token can know about.
  useEffect(() => {
    let cancelled = false;
    // The session that this restore is allowed to write back. If anything replaces the session while the
    // request is in flight — a sign-out, or a sign-in as someone else — applying the response would
    // resurrect a dead session, or worse, overwrite a NEWER account with the previous one.
    let restoring: Session | null = null;

    (async () => {
      let stored: Session | null = null;
      try {
        stored = await loadSession();
      } catch {
        // SecureStore can reject (keychain unavailable, corrupted item). Settling to null sends the user
        // to login; leaving `session` undefined would strand the index route on its spinner forever with
        // no way to reach the login screen at all.
        if (!cancelled) setSession(null);
        return;
      }
      if (cancelled) return;
      if (!stored) {
        setSession(null);
        return;
      }

      restoring = stored;
      sessionRef.current = stored;
      setSession(stored);

      try {
        const fresh = await authApi.me(fetcher, stored.token);
        if (cancelled || sessionRef.current !== restoring) return;
        if (!isAllowedRole(fresh.role)) {
          await signOut();
          return;
        }
        const merged: Session = { ...stored, user: { ...stored.user, ...fresh } };
        sessionRef.current = merged;
        setSession(merged);
        await saveSession(merged);
      } catch (err) {
        // A 401 already triggered signOut via onUnauthorized. Anything else — offline, 5xx, timeout —
        // must NOT sign the user out: the app opens on the cached session and screens surface their own
        // errors. Signing out on a flaky connection is exactly the wrong behaviour in the field.
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetcher, signOut]);

  const signIn = useCallback(async (input: { email: string; password: string }) => {
    const result = await authApi.login(apiFetch, input);
    if (!isAllowedRole(result.user.role)) {
      // The server also refuses field_contractor at /api/auth/mobile-login; this is the client-side
      // mirror so the message is specific instead of a bare 403 on the first screen.
      throw new RoleNotAllowedError();
    }
    const next: Session = {
      token: result.token,
      user: result.user,
      activeOfficeId: result.user.activeOfficeId ?? null,
    };
    sessionRef.current = next;
    setSession(next);
    await saveSession(next);
  }, []);

  const setActiveOffice = useCallback(async (officeId: string | null) => {
    const current = sessionRef.current;
    if (!current) return;
    const next: Session = { ...current, activeOfficeId: officeId };
    sessionRef.current = next;
    setSession(next);
    await saveSession(next);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ session, signIn, signOut, setActiveOffice, fetcher }),
    [session, signIn, signOut, setActiveOffice, fetcher],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export type { CrmUser };
