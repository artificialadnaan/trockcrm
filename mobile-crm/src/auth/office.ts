/**
 * Which office should a restored session be active in?
 *
 * Multi-office is schema-per-tenant on the server: `x-office-id` selects the Postgres schema every
 * subsequent query reads. So getting this wrong is not a stale badge — it either 403s the whole app (a
 * revoked office kept) or shows another office's pipeline as though it were the user's (a wrong office
 * chosen). Both are worse than a slightly-out-of-date one.
 *
 * The subtle part is that /auth/me is deliberately answered WITHOUT an office header, so the office it
 * reports is always the user's PRIMARY one. A genuinely-selected SECONDARY office therefore never equals
 * it, and comparing the two was silently discarding that selection on every single launch.
 * accessible-offices is the list that actually says whether the grant still stands.
 */
export function chooseActiveOffice(input: {
  /** The office persisted from the user's last session, or null if they never switched. */
  storedActiveOfficeId: string | null;
  /** What /auth/me reports — the user's primary office, since that call sends no office header. */
  serverOfficeId: string | null;
  /**
   * Ids from /auth/accessible-offices, or NULL when that lookup could not be made (offline, 5xx). Null
   * is not the same as an empty list: an empty list is a definitive "you have no offices".
   */
  accessibleOfficeIds: string[] | null;
}): string | null {
  const { storedActiveOfficeId, serverOfficeId, accessibleOfficeIds } = input;

  // Never switched, or explicitly cleared. Nothing to preserve, and the fetcher falls back to
  // user.officeId anyway.
  if (!storedActiveOfficeId) return null;

  // Already the office the server reports. No lookup needed — this is the common case and it must not
  // cost a request on every launch.
  if (storedActiveOfficeId === serverOfficeId) return storedActiveOfficeId;

  // The lookup failed. Keep what the user chose: a genuinely revoked grant surfaces as a visible,
  // recoverable 403 on the next request, whereas silently reverting their office presents another
  // office's data as their own — the failure mode with no error attached to it.
  if (accessibleOfficeIds === null) return storedActiveOfficeId;

  return accessibleOfficeIds.includes(storedActiveOfficeId) ? storedActiveOfficeId : null;
}
