import * as SecureStore from "expo-secure-store";
import type { FieldUser } from "../api/types";

// Field roles the app accepts (mirrors client-field FIELD_APP_ALLOWED_ROLES).
export const FIELD_APP_ALLOWED_ROLES = new Set<string>([
  "admin",
  "director",
  "rep",
  "construction",
  "field_contractor",
]);

const KEY = "trock.cam.session.v1";

/**
 * Persisted field session. `token` is the JWT (~30d, no refresh — see the server's
 * FIELD_JWT_EXPIRES_IN) returned in the login / accept-invite response body; `activeOfficeId` is the
 * optional multi-office override (defaults to the user's primary office = user.tenantId).
 */
export type Session = {
  token: string;
  user: FieldUser;
  activeOfficeId: string | null;
};

export function isAllowedRole(role: unknown): boolean {
  return typeof role === "string" && FIELD_APP_ALLOWED_ROLES.has(role);
}

function isValidSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const s = value as { token?: unknown; user?: unknown };
  if (typeof s.token !== "string" || s.token.length === 0) return false;
  if (typeof s.user !== "object" || s.user === null) return false;
  const u = s.user as { id?: unknown; email?: unknown; role?: unknown; tenantId?: unknown };
  return (
    typeof u.id === "string" &&
    typeof u.email === "string" &&
    typeof u.tenantId === "string" &&
    isAllowedRole(u.role)
  );
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Self-contained base64url -> binary-string decoder (no atob / no DOM lib dependency) so it behaves
// identically in Hermes, jest, and tsc. JWT payloads are ASCII JSON, so byte-per-char is correct here.
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

// Best-effort client-side expiry read: decode the JWT payload's `exp` WITHOUT verifying the signature
// (the server stays the source of truth on every request) — purely so an already-expired stored token
// routes straight to login instead of flashing the app and then bouncing on the first 401. Any parse
// failure returns false (treat as NOT expired) so we never sign out a session we merely couldn't read.
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

export async function loadSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await clearSession();
    return null;
  }
  if (!isValidSession(parsed)) {
    await clearSession();
    return null;
  }
  // If the stored token looks expired, route straight to login (no app flash + 401 bounce) — but do NOT
  // delete it. This check trusts the device clock; a fast/wrong clock could judge a server-valid token
  // expired, and a destructive delete would log the user out irreversibly even after the clock corrects.
  // The server's 401 on a genuinely invalid token remains the authority that clears the session (signOut);
  // if the clock self-corrects, a later launch restores the still-valid token.
  if (isTokenExpired(parsed.token)) {
    return null;
  }
  return {
    token: parsed.token,
    user: parsed.user,
    activeOfficeId: typeof parsed.activeOfficeId === "string" ? parsed.activeOfficeId : null,
  };
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
