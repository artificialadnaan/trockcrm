import { useAuth } from "./AuthContext";

/**
 * The office id every request is actually scoped by.
 *
 * MUST stay identical to the expression AuthContext's fetcher uses for the x-office-id header
 * (`activeOfficeId ?? user.officeId`). If a query key were built from `activeOfficeId` alone, a user who
 * has never switched office would key every entry under `null` while the header sent their primary
 * office — so two different offices would collapse onto one cache entry and serve each other's rows.
 * Offices are separate Postgres schemas, so that is wrong data, not a stale count.
 */
export function useOfficeId(): string | null {
  const { session } = useAuth();
  if (!session) return null;
  return session.activeOfficeId ?? session.user.officeId ?? null;
}
