import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { apiFetch, ApiError, type ApiFetchOptions } from "../api/client";
import * as authApi from "../api/endpoints/auth";
import { chooseActiveOffice, isOfficeConfirmed, type OfficeProbe } from "./office";
import { createSerialRunner } from "../lib/serial";
import { createPersistQueue } from "./persist-queue";
import { hasAnyCrmSurface } from "./surfaces";
import { clearSession, isAllowedRole, loadSession, saveSession, type Session } from "./session";
import type { CrmUser } from "../api/types";

/**
 * How current is the session's server-side state?
 *
 *   "checking" — a revalidation is in flight and has not yet answered. Client-enforced gates must BLOCK
 *                here, because a cached `requiresOnboarding: false` is exactly the value that is wrong.
 *   "fresh"    — /auth/me answered; the session reflects the server.
 *   "stale"    — running on the cached session because the check failed or is taking too long. Retried
 *                automatically, and on every return to foreground.
 */
export type GateState = "checking" | "fresh" | "stale";

type AuthState = {
  /** Null once restore has finished and there is no session. `undefined` means "still restoring". */
  session: Session | null | undefined;
  /** Whether the session has been confirmed against the server this launch. See GateState. */
  gate: GateState;
  /** Re-run /auth/me now. Used by the onboarding screen, which is waiting for a flag to clear. */
  revalidate: () => Promise<void>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setActiveOffice: (officeId: string | null) => Promise<void>;
  /** A ready-to-use fetcher carrying the current token + active office. */
  fetcher: authApi.Fetcher;
};

/**
 * How long the app will wait for a first answer before proceeding on cached data.
 *
 * apiFetch's timeout is 30s, so without a bound an offline launch would hold every user on a spinner for
 * half a minute — in an app whose whole purpose is to work from a roof with one bar. After the grace the
 * cached session is used and revalidation continues in the background.
 */
const GATE_GRACE_MS = 3_000;

/** How often to retry once we are knowingly running on stale data. */
const REVALIDATE_RETRY_MS = 30_000;

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

/**
 * Thrown when the account is a valid CRM user but its role reaches none of this app's surfaces — today,
 * `construction`, which the web grants only Capture/Feed/Tickets. Distinct from RoleNotAllowedError so
 * the login screen can point them at T-Rock Cam instead of implying their credentials are wrong.
 */
export class NoAccessibleSurfaceError extends Error {
  constructor() {
    super("This account doesn't have access to the CRM app. Use T-Rock Cam for field work.");
    this.name = "NoAccessibleSurfaceError";
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [gate, setGate] = useState<GateState>("checking");

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
  const persistRef = useRef<ReturnType<typeof createPersistQueue> | null>(null);
  if (!persistRef.current) {
    persistRef.current = createPersistQueue(() => authGenerationRef.current);
  }

  const signOut = useCallback(async () => {
    authGenerationRef.current += 1;
    sessionRef.current = null;
    setSession(null);
    // clear(), not save(): a queued sign-out must NOT be discarded because a sign-in has since advanced
    // the generation. If that replacement save then fails, the new account is never published and the
    // signed-out account's token is still on disk — the next launch restores an account somebody
    // explicitly signed out of. See createPersistQueue.
    try {
      await persistRef.current!.clear(clearSession);
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

  /**
   * Confirm the CURRENT session against the server.
   *
   * Runs on launch, on every return to foreground, on a retry timer while stale, and on demand from the
   * onboarding screen. The stored token's own `exp` is checked locally first (cheap, offline-safe);
   * /auth/me is what catches a deactivated user, a bumped token_version, a role change, or newly
   * assigned cleanup work — none of which a stored token can know about.
   *
   * Running it repeatedly rather than once at launch is what makes the client-enforced onboarding gate
   * trustworthy: a single launch request that failed transiently used to leave the user past the gate
   * for the entire life of the process, with no retry and nothing on screen to indicate it.
   */
  const runRevalidation = useCallback(async (): Promise<void> => {
    // The session this revalidation is allowed to write back. If anything replaces it while the request
    // is in flight — a sign-out, or a sign-in as someone else — applying the response would resurrect a
    // dead session, or worse, overwrite a NEWER account with the previous one.
    const stored = sessionRef.current;
    if (!stored) {
      setGate("fresh");
      return;
    }
    const generation = authGenerationRef.current;

    // A SCOPED unauthorized handler, not the fetcher's global one. The global handler runs inside
    // apiFetch — i.e. BEFORE the identity check below — so a late 401 belonging to this old token
    // would sign out whatever session is current by then, including a different account the user has
    // since signed into. This one only tears down the session it was actually issued for.
    const scoped = <T,>(path: string, opts: ApiFetchOptions = {}) =>
      fetcher<T>(path, {
        ...opts,
        onUnauthorized: () => {
          if (sessionRef.current === stored) void signOut();
        },
      });

      try {
        const fresh = await authApi.me(scoped, stored.token);
        if (sessionRef.current !== stored) return;
        // A role can change server-side after sign-in. Both checks belong here, not just the first: a
        // user demoted to `construction` still passes requireCrmUser but reaches no surface in this app,
        // so leaving them signed in means an authenticated shell with every screen hidden.
        if (!isAllowedRole(fresh.role) || !hasAnyCrmSurface(fresh.role)) {
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
            if (sessionRef.current !== stored) return;
            probe = "granted";
            effective = inOffice;
          } catch (err) {
            if (sessionRef.current !== stored) return;
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
        /**
         * The ONBOARDING fields are office-scoped, and that changes what an unconfirmed office means.
         *
         * withOnboardingGate resolves the office slug to a tenant SCHEMA and counts pending cleanup
         * inside it (auth/service.ts:68-130), so `requiresOnboarding` from the header-less /auth/me
         * describes the HOME office only. When a secondary office is kept without a successful probe,
         * copying those fields over would answer a question about office A with a fact about office B —
         * and if cleanup is pending only in the secondary office, that answer is `false`, which opens the
         * gate. Keep the cached office-scoped values instead, and stay "stale" so the retry keeps running.
         */
        // See isOfficeConfirmed: the absence of a probe is not doubt when no probe was needed.
        const officeConfirmed = isOfficeConfirmed({
          activeOfficeId: keepActive,
          serverOfficeId: serverOffice,
          probe,
        });
        const officeScopedGate = officeConfirmed
          ? {}
          : {
              requiresOnboarding: stored.user.requiresOnboarding,
              onboardingPendingCount: stored.user.onboardingPendingCount,
              role: stored.user.role,
            };

        const merged: Session = {
          ...stored,
          user: officeConfirmed
            ? // `effective` only differs from `fresh` when a probe ran and was granted.
              { ...stored.user, ...(probe === "granted" ? effective : fresh) }
            : { ...stored.user, ...fresh, ...officeScopedGate },
          activeOfficeId: keepActive,
        };
        sessionRef.current = merged;
        setSession(merged);
        // "fresh" ONLY when the office the session will actually use was confirmed. Marking an
        // unconfirmed secondary office fresh both opens the gate on home-office data and disables the
        // retry timer, so nothing would ever correct it.
        setGate(officeConfirmed ? "fresh" : "stale");

        // Persist OUTSIDE the try below, and guarded on its own. `sessionRef.current` is now `merged`, so
        // the catch's identity check would treat the provider's own update as a session replacement and
        // swallow a keychain failure — leaving memory fresh, disk holding the previous onboarding, role
        // and office state, and no retry. The next offline launch would restore that obsolete state.
        try {
          await persistRef.current!.save(generation, () => saveSession(merged));
        } catch {
          // The confirmed in-memory session STANDS — rolling it back would discard good server state over
          // a storage problem. Only the write is retried, via the stale path.
          if (sessionRef.current === merged) setGate("stale");
        }
      } catch (err) {
        // A 401 already triggered the scoped signOut above. Anything else — offline, 5xx, timeout — must
        // NOT sign the user out: the app opens on the cached session and screens surface their own
        // errors. Signing out on a flaky connection is exactly the wrong behaviour in the field.
        if (sessionRef.current !== stored) return;
        if (err instanceof ApiError && err.status === 401) return;
        // Knowingly running on cached data. The retry effect below picks this up, so a transient failure
        // no longer leaves a client-enforced gate unverified for the whole life of the process.
        setGate("stale");
      }
  }, [fetcher, signOut]);

  /**
   * Public entry point: SERIALISED so overlapping callers cannot discard each other's results.
   *
   * Four things now trigger revalidation — launch, the stale retry, the foreground listener, and the
   * onboarding screen's button — and without sequencing two can be in flight at once. Both capture the
   * same `stored`, the first response to land replaces sessionRef.current, and the second then fails its
   * own identity check and is thrown away *even though it is newer*. If onboarding was assigned or
   * cleared between the two requests, the older answer wins and marks the gate fresh.
   *
   * Chaining makes the newest invocation the last to run, and each one re-reads sessionRef.current when
   * its turn arrives, so it sees whatever the previous one wrote.
   */
  const revalidateRunnerRef = useRef<ReturnType<typeof createSerialRunner> | null>(null);
  if (!revalidateRunnerRef.current) revalidateRunnerRef.current = createSerialRunner();
  const revalidate = useCallback(
    (): Promise<void> => revalidateRunnerRef.current!(runRevalidation),
    [runRevalidation],
  );

  // Restore from the keychain on launch, publish, then confirm against the server.
  useEffect(() => {
    let cancelled = false;
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
        if (!cancelled && generation === authGenerationRef.current) {
          setSession(null);
          setGate("fresh");
        }
        return;
      }
      if (cancelled || generation !== authGenerationRef.current) return;
      if (!stored) {
        setSession(null);
        setGate("fresh");
        return;
      }

      sessionRef.current = stored;
      setSession(stored);
      await revalidate();
    })();

    return () => {
      cancelled = true;
    };
  }, [revalidate]);

  // Bounded wait for the FIRST answer. Without it an offline launch would hold the app on a spinner for
  // apiFetch's full 30s timeout — unusable in the field, which is the whole point of this app.
  useEffect(() => {
    if (gate !== "checking") return;
    const timer = setTimeout(() => setGate((g) => (g === "checking" ? "stale" : g)), GATE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [gate]);

  // Retry while stale. `retryTick` exists because setGate("stale") on an already-stale gate is a no-op
  // and would never re-arm this timer, so a failing revalidation would stop retrying after one attempt.
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    if (gate !== "stale" || !sessionRef.current) return;
    const timer = setTimeout(() => setRetryTick((n) => n + 1), REVALIDATE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [gate, retryTick]);
  useEffect(() => {
    if (retryTick === 0) return;
    void revalidate();
  }, [retryTick, revalidate]);

  // Revalidate whenever the app comes back to the foreground. This is also what releases a user who left
  // for the cleanup workspace in an external browser and came back: without it the provider never
  // remounts, so `requiresOnboarding` stays true until they force-quit or sign out and back in.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && sessionRef.current) void revalidate();
    });
    return () => sub.remove();
  }, [revalidate]);

  const signIn = useCallback(
    async (input: { email: string; password: string }) => {
      const result = await authApi.login(apiFetch, input);
      if (!isAllowedRole(result.user.role)) {
        // The server also refuses field_contractor at /api/auth/mobile-login; this is the client-side
        // mirror so the message is specific instead of a bare 403 on the first screen.
        throw new RoleNotAllowedError();
      }
      if (!hasAnyCrmSurface(result.user.role)) {
        // Passes the server's CRM boundary but reaches none of this app's surfaces — `construction`
        // today. Letting them in would land them in an app with every screen hidden; the web grants that
        // role only Capture/Feed/Tickets, and T-Rock Cam already covers the field work.
        throw new NoAccessibleSurfaceError();
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
      await persistRef.current!.save(generation, () => saveSession(next));
      if (generation !== authGenerationRef.current) return;
      sessionRef.current = next;
      setSession(next);
    },
    [],
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
        await persistRef.current!.save(authGenerationRef.current, () => saveSession(next));
      } catch {
        // The switch has already been applied in memory and the app is usable in the new office. A
        // failed write only means the choice will not survive a relaunch — not a reason to reject here
        // and leave the caller with an unhandled rejection for a switch that visibly succeeded.
      }
    },
    [],
  );

  const value = useMemo<AuthState>(
    () => ({ session, gate, revalidate, signIn, signOut, setActiveOffice, fetcher }),
    [session, gate, revalidate, signIn, signOut, setActiveOffice, fetcher],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export type { CrmUser };
