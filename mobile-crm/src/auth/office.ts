/**
 * The result of asking the server about a stored secondary office.
 *
 * "unknown" is NOT "revoked": offline, a 5xx, or a gate that refuses the probe for an unrelated reason
 * all leave the question genuinely unanswered, and treating that as revoked silently moves the user to a
 * different Postgres schema with no error to explain it.
 */
export type OfficeProbe = "granted" | "revoked" | "unknown";

/**
 * Which office should a restored session be active in?
 *
 * Multi-office is schema-per-tenant on the server: `x-office-id` selects the Postgres schema every
 * subsequent query reads. So getting this wrong is not a stale badge — it either 403s the whole app (a
 * revoked office kept) or shows another office's pipeline as though it were the user's (a wrong office
 * chosen). Both are worse than a slightly-out-of-date one.
 *
 * The subtle part is that /auth/me answered WITHOUT an office header always reports the user's PRIMARY
 * office. A genuinely-selected SECONDARY office therefore never equals it, and comparing the two was
 * silently discarding that selection on every single launch. Only a mismatch is worth a probe.
 */
export function chooseActiveOffice(input: {
  /** The office persisted from the user's last session, or null if they never switched. */
  storedActiveOfficeId: string | null;
  /** What /auth/me reports without an office header — i.e. the user's primary office. */
  serverOfficeId: string | null;
  /** The probe result, or null when no probe was needed (see below). */
  probe: OfficeProbe | null;
}): string | null {
  const { storedActiveOfficeId, serverOfficeId, probe } = input;

  // Never switched, or explicitly cleared. Nothing to preserve — the fetcher falls back to user.officeId.
  if (!storedActiveOfficeId) return null;

  // Already the office the server reports. No probe needed, and this is the common case: it must not
  // cost a request on every launch.
  if (storedActiveOfficeId === serverOfficeId) return storedActiveOfficeId;

  // Only a definitive "revoked" drops the selection. Both "unknown" and an absent probe keep it: a
  // genuinely revoked grant surfaces as a visible, recoverable 403 on the next request, whereas silently
  // reverting presents another office's data as the user's own — the failure with no error attached.
  return probe === "revoked" ? null : storedActiveOfficeId;
}

/**
 * Did /auth/me actually answer for the office this session will use?
 *
 * The header-less /auth/me answers for the user's HOME office, and its office-scoped fields
 * (`requiresOnboarding`, the effective `role`) describe that office only. So "confirmed" means the
 * active office after reconciliation is one that response covers:
 *
 *   - no office kept                → falls back to the home office ✓
 *   - the kept office IS the home office → same response, no probe needed. The ABSENCE of a probe here
 *                                          is not doubt, and treating it as doubt marked every ordinary
 *                                          session unconfirmed — signIn seeds activeOfficeId from the
 *                                          login response, so it equals the home office on every launch.
 *   - a genuine secondary office    → only a granted probe confirms it
 */
export function isOfficeConfirmed(input: {
  activeOfficeId: string | null;
  serverOfficeId: string | null;
  probe: OfficeProbe | null;
}): boolean {
  const { activeOfficeId, serverOfficeId, probe } = input;
  if (!activeOfficeId) return true;
  if (activeOfficeId === serverOfficeId) return true;
  return probe === "granted";
}
