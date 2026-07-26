import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, ApiError, type ApiFetchOptions } from "../api/client";
import * as authApi from "../api/endpoints/auth";
import { chooseActiveOffice, type OfficeProbe } from "./office";
import { createPersistQueue } from "./persist-queue";
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

  /**
   * Bumped by every deliberate identity change (sign-in, sign-out). Async work captures it BEFORE it
   * starts and re-checks afterwards, which object identity alone cannot do: the launch restore reads the
   * keychain before it has a session object to compare against, so a sign-in that lands mid-read would
   * otherwise be silently overwritten by whatever the slow read returns.
   */
  const authGenerationRef = useRef(0);

  /**
   * Serialises every SecureStore mutation and drops any a newer identity change has superseded — see
   * createPersistQueue. Held in a ref so it is created once and survives re-renders.
   */
  const enqueuePersistRef = useRef<ReturnType<typeof createPersistQueue> | null>(null);
  if (!enqueuePersistRef.current) {
    enqueuePersistRef.current = createPersistQueue(() => authGenerationRef.current);
  }
  const enqueuePersist = useCallback(
    (generation: number, op: () => Promise<void>) => enqueuePersistRef.current!(generation, op),
    [],
  );

  const signOut = useCallback(async () => {
    const generation = ++authGenerationRef.current;
    sessionRef.current = null;
    setSession(null);
    try {
      await enqueuePersist(generation, clearSession);
    } catch {
      // clearSession already tried both delete and overwrite. In-memory state is signed out either way,
      // and swallowing here keeps callers that await signOut() and then navigate — the change-password
      // screen does exactly that — from being stranded on a dead screen by a keychain hiccup.
    }
  }, [enqueuePersist]);

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
    // Captured BEFORE the keychain read, because until that read returns there is no session object to
    // compare identities against. The login screen is usable the whole time this is pending: a cold open
    // straight to /login, a sign-in as B, then a slow read returning A would have replaced B with A.
    const generation = authGenerationRef.current;

    (async () => {
      let stored: Session | null = null;
      try {
        stored = await loadSession();
      } catch {
        // SecureStore can reject (keychain unavailable, corrupted item). Settling to null sends the user
        // to login; leaving `session` undefined would strand the index route on its spinner forever with
        // no way to reach the login screen at all.
        if (!cancelled && generation === authGenerationRef.current) setSession(null);
        return;
      }
      if (cancelled || generation !== authGenerationRef.current) return;
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

        /**
         * Probe a stored SECONDARY office with a second /auth/me, this time carrying x-office-id.
         *
         * One request answers both questions authoritatively:
         *   - authMiddleware checks office access first and 403s a revoked grant, so the status IS the
         *     grant check; and
         *   - when it succeeds, the `role` it returns is the office-EFFECTIVE role, because
         *     user_office_access.role_override is applied for the requested office (middleware/auth.ts
         *     73-81). /auth/me without the header can only ever report the home-office role, so merging
         *     that over the cached user showed a rep who is an admin in this office as a rep — while
         *     their requests were being authorised as an admin.
         *
         * Also survives a forced password change, which /auth/accessible-offices does not: only
         * /auth/me, /auth/logout and /auth/local/change-password are exempt from that gate.
         */
        let probe: OfficeProbe | null = null;
        let effective = fresh;
        if (stored.activeOfficeId && stored.activeOfficeId !== serverOffice) {
          try {
            const inOffice = await authApi.me(
              <T,>(path: string, opts: ApiFetchOptions = {}) =>
                scoped<T>(path, { ...opts, officeId: stored!.activeOfficeId }),
              stored.token,
            );
            if (cancelled || sessionRef.current !== restoring) return;
            probe = "granted";
            effective = inOffice;
          } catch (err) {
            if (cancelled || sessionRef.current !== restoring) return;
            if (err instanceof ApiError && err.status === 401) return;
            // 403 is the definitive "no access to requested office". Anything else — offline, 5xx, or the
            // password-change gate answering before the office question — leaves it genuinely unknown.
            probe = err instanceof ApiError && err.status === 403 ? "revoked" : "unknown";
          }
        }

        const keepActive = chooseActiveOffice({
          storedActiveOfficeId: stored.activeOfficeId,
          serverOfficeId: serverOffice,
          probe,
        });

        /**
         * Which user record describes the office requests will actually be sent under?
         *
         *   - office dropped        → the home-office `fresh`, which is exactly right.
         *   - probe granted         → the in-office response, carrying the office-effective role.
         *   - probe unknown/absent  → the office was KEPT without confirmation, so the home-office role
         *                             does not describe it. Merging `fresh` would overwrite a cached
         *                             role_override with the home role while every request still sends
         *                             the secondary office id — the displayed role and client-side
         *                             permission gates would then disagree with what authMiddleware
         *                             actually enforces. Keep the cached role instead; a stale role is
         *                             better than a confidently wrong one.
         */
        const merged: Session = {
          ...stored,
          user: !keepActive
            ? { ...stored.user, ...fresh }
            : probe === "granted"
              ? { ...stored.user, ...effective }
              : { ...stored.user, ...fresh, role: stored.user.role },
          activeOfficeId: keepActive,
        };
        sessionRef.current = merged;
        setSession(merged);
        await enqueuePersist(generation, () => saveSession(merged));
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

  const signIn = useCallback(
    async (input: { email: string; password: string }) => {
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
      // Claim the generation BEFORE writing, so any restore or sign-out still in flight is superseded
      // rather than allowed to overwrite this account.
      const generation = ++authGenerationRef.current;
      // Persist FIRST. If SecureStore rejects after we had already published the session, signIn still
      // rejects — so the login screen shows a failure and does not navigate, while the context and
      // fetcher are silently authenticated behind it. Writing first leaves nothing behind on failure.
      await enqueuePersist(generation, () => saveSession(next));
      if (generation !== authGenerationRef.current) return;
      sessionRef.current = next;
      setSession(next);
    },
    [enqueuePersist],
  );

  const setActiveOffice = useCallback(
    async (officeId: string | null) => {
      const current = sessionRef.current;
      if (!current) return;
      const next: Session = { ...current, activeOfficeId: officeId };
      sessionRef.current = next;
      setSession(next);
      try {
        // Not a new identity, so it does NOT bump the generation — it rides on the current one and is
        // skipped if a sign-out or sign-in overtakes it.
        await enqueuePersist(authGenerationRef.current, () => saveSession(next));
      } catch {
        // The switch has already been applied in memory and the app is usable in the new office. A
        // failed write only means the choice will not survive a relaunch — not a reason to reject here
        // and leave the caller with an unhandled rejection for a switch that visibly succeeded.
      }
    },
    [enqueuePersist],
  );

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
