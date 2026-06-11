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
 * Persisted field session. `token` is the JWT (24h, no refresh) returned in the
 * login / accept-invite response body; `activeOfficeId` is the optional
 * multi-office override (defaults to the user's primary office = user.tenantId).
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
  return {
    token: parsed.token,
    user: parsed.user,
    activeOfficeId: typeof parsed.activeOfficeId === "string" ? parsed.activeOfficeId : null,
  };
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
