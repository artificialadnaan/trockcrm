import type { AccessibleOffice, CrmUser, MobileLoginResponse } from "../types";
import type { ApiFetchOptions } from "../client";

/**
 * Endpoint modules take the fetcher by injection rather than importing apiFetch directly, so they are
 * unit-testable with no network and no module mocking. Mirrors mobile/src/api/endpoints.ts.
 */
export type Fetcher = <T>(path: string, opts?: ApiFetchOptions) => Promise<T>;

/**
 * Native login. Deliberately NOT /api/auth/local/login: that endpoint delivers its JWT as an httpOnly
 * cookie and returns only {user, returnTo, csrfToken}, which a native client cannot read. This one
 * returns the token in the body. Added in PR #959.
 */
export async function login(
  fetcher: Fetcher,
  input: { email: string; password: string },
): Promise<MobileLoginResponse> {
  return fetcher<MobileLoginResponse>("/auth/mobile-login", {
    method: "POST",
    body: { email: input.email, password: input.password },
  });
}

/**
 * Revalidate a stored session against the server on launch. The local expiry check in session.ts only
 * reads the JWT's `exp`; this is what catches a deactivated user, a bumped token_version, or a role
 * change — all of which the server enforces per-request but which a stored token cannot know about.
 */
export async function me(fetcher: Fetcher, token: string): Promise<CrmUser> {
  return fetcher<CrmUser>("/auth/me", { token });
}

/**
 * Offices this user may switch into. Multi-office is schema-per-tenant on the server (search_path is set
 * per request from x-office-id), so switching office changes which database schema every subsequent
 * query reads — which is why the switcher has to be explicit and visible rather than inferred.
 */
export async function accessibleOffices(fetcher: Fetcher, token: string): Promise<AccessibleOffice[]> {
  return fetcher<AccessibleOffice[]>("/auth/accessible-offices", { token });
}
