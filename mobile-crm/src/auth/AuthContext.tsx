import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, ApiError, type ApiFetchOptions } from "../api/client";
import * as authApi from "../api/endpoints/auth";
import { chooseActiveOffice } from "./office";
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
    try {
      await clearSession();
    } catch {
      // clearSession already tried both delete and overwrite. In-memory state is signed out either way,
      // and swallowing here keeps callers that await signOut() and then navigate — the change-password
      // screen does exactly that — from being stranded on a dead screen by a keychain hiccup.
    }
  }, []);

  const fetcher = useCallback(
    <T,>(path: string, opts: ApiFetchOptions = {}) => {
      const current = sessionRef.current;
      return apiFetch<T>(path, {
        token: current?.token ?? null,
        officeId: current?.activeOfficeId ?? current?.user.officeId ?? null,
        // Only a 401 tears down the session — see the client's onUnauthorized doc. A 403 is an
        // authorization failure on one action and must NOT sign the user out.
        //
        // SCOPED to the session that issued this request. Requests outlive the session that started
        // them: a screen's request fires, the user signs out and signs in as someone else, and the first
        // response arrives carrying a 401 for the OLD token. Signing out on "whatever is current now"
        // ejects the account that just signed in — on shared field devices this is a routine sequence,
        // not a rare race.
        onUnauthorized: () => {
          if (current && sessionRef.current === current) void signOut();
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

      // A SCOPED unauthorized handler, not the fetcher's global one. The global handler runs inside
      // apiFetch — i.e. BEFORE the identity check below — so a late 401 belonging to this old token
      // would sign out whatever session is current by then, including a different account the user has
      // since signed into. This one only tears down the session it was actually issued for.
      const scoped = <T,>(path: string, opts: ApiFetchOptions = {}) =>
        fetcher<T>(path, {
          ...opts,
          onUnauthorized: () => {
            if (!cancelled && sessionRef.current === restoring) void signOut();
          },
        });

      try {
        const fresh = await authApi.me(scoped, stored.token);
        if (cancelled || sessionRef.current !== restoring) return;
        if (!isAllowedRole(fresh.role)) {
          await signOut();
          return;
        }

        // Reconcile the ACTIVE OFFICE too, not just the user. `activeOfficeId` is a persisted secondary
        // office; if an admin revoked that grant, keeping it would send a stale x-office-id on every
        // subsequent request and 403 the whole app.
        //
        // But /auth/me is answered deliberately WITHOUT x-office-id, so the office it reports is always
        // the user's PRIMARY one. Comparing a secondary office against that never matches, which would
        // silently drop a legitimately-selected secondary office on EVERY launch. accessible-offices is
        // the list that actually says whether the grant still stands, so only a mismatch pays for it.
        const serverOffice = fresh.activeOfficeId ?? fresh.officeId ?? null;

        // Only a stored office that DIFFERS from the primary one costs a lookup — see chooseActiveOffice.
        let accessibleOfficeIds: string[] | null = null;
        if (stored.activeOfficeId && stored.activeOfficeId !== serverOffice) {
          try {
            const offices = await authApi.accessibleOffices(
              // No x-office-id here either: if the grant WAS revoked, sending it would 403 the very call
              // whose job is to find that out.
              <T,>(path: string, opts: ApiFetchOptions = {}) => scoped<T>(path, { ...opts, officeId: null }),
              stored.token,
            );
            if (cancelled || sessionRef.current !== restoring) return;
            accessibleOfficeIds = offices.map((o) => o.id);
          } catch (err) {
            if (cancelled || sessionRef.current !== restoring) return;
            if (err instanceof ApiError && err.status === 401) return;
            // Leave it null — "could not determine", which chooseActiveOffice treats as keep-what-you-had.
          }
        }

        const keepActive = chooseActiveOffice({
          storedActiveOfficeId: stored.activeOfficeId,
          serverOfficeId: serverOffice,
          accessibleOfficeIds,
        });

        const merged: Session = {
          ...stored,
          user: { ...stored.user, ...fresh },
          activeOfficeId: keepActive,
        };
        sessionRef.current = merged;
        setSession(merged);
        await saveSession(merged);
      } catch (err) {
        // A 401 already triggered the scoped signOut above. Anything else — offline, 5xx, timeout — must
        // NOT sign the user out: the app opens on the cached session and screens surface their own
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
    // Persist FIRST. If SecureStore rejects after we had already published the session, signIn still
    // rejects — so the login screen shows a failure and does not navigate, while the context and fetcher
    // are silently authenticated behind it. Writing first means a storage failure leaves nothing behind.
    await saveSession(next);
    sessionRef.current = next;
    setSession(next);
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
