import type { AccessibleOffice, CrmUser, MobileLoginResponse } from "../types";
import type { ApiFetchOptions } from "../client";

/**
 * Endpoint modules take the fetcher by injection rather than importing apiFetch directly, so they are
 * unit-testable with no network and no module mocking. Mirrors mobile/src/api/endpoints.ts.
 *
 * NOTE ON ENVELOPES: the CRM auth routes are not uniform. /auth/mobile-login returns {token, user} at the
 * top level, but /auth/me returns {user, csrfToken?} and /auth/accessible-offices returns {offices}.
 * Unwrapping happens HERE so the rest of the app sees plain values — and so a wrong assumption is a
 * one-line fix in one place rather than scattered across screens.
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
 * change — none of which a stored token can know about.
 *
 * Sends NO x-office-id. The stored session's office may be stale: if an admin moved the user's primary
 * office or revoked a secondary-office grant, that header is rejected before /auth/me can tell us the
 * current one — the exact call whose job is to resolve the staleness would be the one blocked by it.
 * Omitting the header lets the server fall back to the user's own office.
 */
export async function me(fetcher: Fetcher, token: string): Promise<CrmUser> {
  const res = await fetcher<{ user: CrmUser }>("/auth/me", { token, officeId: null });
  return res.user;
}

/**
 * Offices this user may switch into. Multi-office is schema-per-tenant on the server (search_path is set
 * per request from x-office-id), so switching office changes which database schema every subsequent
 * query reads — which is why the switcher has to be explicit and visible rather than inferred.
 *
 * NOT used by session restore. Confirming a stored secondary office goes through an office-scoped
 * /auth/me instead, which answers the grant question AND returns that office's effective role in one
 * request — and, unlike this endpoint, is exempt from the forced-password-change gate. This stays for
 * the office switcher, which needs the list itself rather than a yes/no on one office.
 *
 * `officeId: null` is LOAD-BEARING, and the reason is self-referential: this is the one request whose
 * answer must not be scoped by where the user currently is. The route derives its argument from
 * `activeOfficeId ?? officeId` (auth/routes.ts:313), and for a non-admin the result is that office UNION
 * their user_office_access grants (auth/service.ts:817-829). A home office normally has no grant row —
 * the SQL's `o.id = $1 OR o.id IN (...)` only makes sense if it doesn't — so sending the active office
 * while a rep sits in a granted SECONDARY office drops their own home office from the list. The switcher
 * then sees one office, hides itself, and strands them there with no way back.
 *
 * Omitting the header makes the middleware fall back to the home office (middleware/auth.ts:70), which
 * is the only anchor that yields the user's true reachable set. The web has the same escape hatch for
 * the same class of problem (`suppressOfficeHeader`, client/src/lib/api.ts:37-44).
 */
export async function accessibleOffices(fetcher: Fetcher, token: string): Promise<AccessibleOffice[]> {
  const res = await fetcher<{ offices: AccessibleOffice[] }>("/auth/accessible-offices", {
    token,
    officeId: null,
  });
  return res.offices ?? [];
}
