import * as SecureStore from "expo-secure-store";
import type { CrmUser } from "../api/types";

/**
 * Roles the CRM app accepts. Deliberately EXCLUDES field_contractor: the server's requireCrmUser rejects
 * that role on every CRM route, so accepting it here would produce a login that appears to succeed and
 * then 403s on every screen. Better to refuse at the door with a clear message.
 */
export const CRM_APP_ALLOWED_ROLES = new Set<string>(["admin", "director", "rep", "construction"]);

/**
 * SecureStore key. MUST differ from T-Rock Cam's "trock.cam.session.v1" — the two apps are separate
 * installs with separate keychains today, but a shared key would collide immediately if they were ever
 * given a shared keychain access group, and the token shapes are not interchangeable (this one carries
 * surface:"mobile"; T-Rock Cam's carries surface:"field" and is rejected on every CRM route).
 */
const KEY = "trock.crm.session.v1";

/**
 * Persisted CRM session. `token` is the JWT from POST /api/auth/mobile-login (30d, no refresh);
 * `activeOfficeId` is the multi-office override, defaulting to the user's primary office.
 */
export type Session = {
  token: string;
  user: CrmUser;
  activeOfficeId: string | null;
};

export function isAllowedRole(role: unknown): boolean {
  return typeof role === "string" && CRM_APP_ALLOWED_ROLES.has(role);
}

function isValidSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const s = value as { token?: unknown; user?: unknown };
  if (typeof s.token !== "string" || s.token.length === 0) return false;
  if (typeof s.user !== "object" || s.user === null) return false;
  const u = s.user as { id?: unknown; email?: unknown; role?: unknown; officeId?: unknown };
  return (
    typeof u.id === "string" &&
    typeof u.email === "string" &&
    typeof u.officeId === "string" &&
    isAllowedRole(u.role)
  );
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Self-contained base64url → binary-string decoder (no atob, no DOM lib) so it behaves identically in
// Hermes, jest and tsc. JWT payloads are ASCII JSON, so byte-per-char is correct here.
function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const ch of b64) {
    if (ch === "=") break;
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * Best-effort client-side expiry read: decode the JWT payload's `exp` WITHOUT verifying the signature
 * (the server stays the source of truth on every request) — purely so an already-expired stored token
 * routes straight to login instead of flashing the app and then bouncing on the first 401. Any parse
 * failure returns false (treat as NOT expired) so we never sign out a session we merely couldn't read.
 */
export function isTokenExpired(token: string, now: number = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: unknown };
    if (typeof payload.exp !== "number") return false;
    return payload.exp * 1000 <= now;
  } catch {
    return false;
  }
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(session));
}

/**
 * The outcome of reading the stored session.
 *
 * `corrupt` means a record was present but unusable — bad JSON, or structurally not a session. The
 * caller is expected to clean it up THROUGH THE PERSISTENCE QUEUE rather than have this function do it:
 * the login screen is usable while this read is in flight, so an unqueued delete from a stale restore
 * could land after a successful sign-in's queued save and erase the account that just signed in.
 * Reading and writing are separated here so that ordering is the caller's to get right, once, in the
 * one place that already owns it.
 */
export type LoadedSession = { session: Session | null; corrupt: boolean };

/** Reads and validates the stored session. PURE with respect to storage — it never writes or deletes. */
export async function loadSession(): Promise<LoadedSession> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return { session: null, corrupt: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { session: null, corrupt: true };
  }
  if (!isValidSession(parsed)) return { session: null, corrupt: true };

  // A token that LOOKS expired routes to login, but is NOT corrupt and must NOT be deleted. This check
  // trusts the device clock; a fast or wrong clock could judge a server-valid token expired, and a
  // destructive delete would log the user out irreversibly even after the clock corrects. The server's
  // 401 remains the only authority that clears a session — if the clock self-corrects, a later launch
  // restores the still-valid token.
  if (isTokenExpired(parsed.token)) return { session: null, corrupt: false };

  return {
    session: {
      token: parsed.token,
      user: parsed.user,
      activeOfficeId: typeof parsed.activeOfficeId === "string" ? parsed.activeOfficeId : null,
    },
    corrupt: false,
  };
}

/**
 * Written over the session when deletion fails. `loadSession` structurally rejects it (no token, no
 * user), so it is as good as deleted — and, unlike a delete, it only needs the keychain to accept a
 * WRITE, which can succeed when a delete does not.
 */
const TOMBSTONE = "{}";

/**
 * Sign-out must be DURABLE. `deleteItemAsync` can reject — a locked or temporarily unavailable keychain
 * is the common case — and a rejection that only clears in-memory state leaves the token on disk, so the
 * next launch silently restores the session the user just signed out of. On a shared field device that
 * hands the account to whoever opens the app next.
 *
 * So: delete, and if that fails, overwrite. Only when both fail does this reject, and the caller is then
 * responsible for still clearing its own state.
 */
export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch (err) {
    try {
      await SecureStore.setItemAsync(KEY, TOMBSTONE);
    } catch {
      throw err;
    }
  }
}
