import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../api/client";
import {
  acceptInvite as acceptInviteEndpoint,
  login as loginEndpoint,
  logout as logoutEndpoint,
  previewInvite as previewInviteEndpoint,
  type Fetcher,
} from "../api/endpoints";
import type { FieldUser, InvitePreview } from "../api/types";
import { clearSession, isAllowedRole, loadSession, saveSession, type Session } from "./session";

type AuthState = {
  /** false until the persisted session has been read — gates first paint. */
  ready: boolean;
  token: string | null;
  user: FieldUser | null;
  activeOfficeId: string | null;
  /** apiFetch bound to the current token + office + sign-out-on-401. */
  fetcher: Fetcher;
  signIn: (email: string, password: string) => Promise<void>;
  acceptInvite: (token: string, password: string) => Promise<void>;
  previewInvite: (token: string) => Promise<InvitePreview>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<AuthState | null>(null);

/** Bare (token-less) fetcher for the public auth endpoints. */
const publicFetcher: Fetcher = (path, opts) => apiFetch(path, opts);

function assertFieldUser(user: FieldUser | null | undefined): FieldUser {
  if (
    !user ||
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    typeof user.tenantId !== "string" ||
    !isAllowedRole(user.role)
  ) {
    throw new ApiError("This account is not authorized for the T-Rock Cam app.", 403);
  }
  return user;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<FieldUser | null>(null);
  const [activeOfficeId, setActiveOfficeId] = useState<string | null>(null);

  const signOut = useCallback(async () => {
    const previousToken = token;
    // Clear in-memory state first so a storage/network failure can never leave
    // the user signed in; wipe the per-user query cache (shared-device safety).
    setToken(null);
    setUser(null);
    setActiveOfficeId(null);
    qc.clear();
    if (previousToken) {
      try {
        await logoutEndpoint((p, o) => apiFetch(p, { ...o, token: previousToken }));
      } catch {
        /* best-effort server logout; local sign-out already happened */
      }
    }
    try {
      await clearSession();
    } catch {
      /* token/user already cleared in memory */
    }
  }, [qc, token]);

  const fetcher = useCallback<Fetcher>(
    (path, opts) =>
      apiFetch(path, {
        ...opts,
        token,
        officeId: activeOfficeId,
        onUnauthorized: () => {
          void signOut();
        },
      }),
    [token, activeOfficeId, signOut],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const s = await loadSession();
        if (active && s) {
          setToken(s.token);
          setUser(s.user);
          setActiveOfficeId(s.activeOfficeId);
        }
      } catch {
        /* a failed session read must not block the app from booting */
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const applyAuth = useCallback(async (res: { token: string; user: FieldUser }) => {
    const validUser = assertFieldUser(res.user);
    const session: Session = { token: res.token, user: validUser, activeOfficeId: null };
    await saveSession(session);
    setToken(session.token);
    setUser(session.user);
    setActiveOfficeId(null);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await loginEndpoint(publicFetcher, email, password);
      await applyAuth(res);
    },
    [applyAuth],
  );

  const acceptInvite = useCallback(
    async (inviteToken: string, password: string) => {
      const res = await acceptInviteEndpoint(publicFetcher, inviteToken, password);
      await applyAuth(res);
    },
    [applyAuth],
  );

  const previewInvite = useCallback(
    (inviteToken: string) => previewInviteEndpoint(publicFetcher, inviteToken),
    [],
  );

  const value = useMemo<AuthState>(
    () => ({ ready, token, user, activeOfficeId, fetcher, signIn, acceptInvite, previewInvite, signOut }),
    [ready, token, user, activeOfficeId, fetcher, signIn, acceptInvite, previewInvite, signOut],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
