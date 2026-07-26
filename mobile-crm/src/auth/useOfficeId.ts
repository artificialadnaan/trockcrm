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

/**
 * The cache scope for every query key: the signed-in USER plus the active office.
 *
 * The office alone is not enough. The QueryClient is created once at module level and sign-out does not
 * clear it, so if two people use the same device — which happens on shared job-site phones — the second
 * account's keys would collide with the first's and TanStack would serve cached rows without a request.
 * That silently leaks owner-scoped "mine" lists and viewer-filtered detail between accounts.
 */
export function useQueryScope(): string {
  const { session } = useAuth();
  const officeId = useOfficeId();
  return `${session?.user.id ?? "anon"}:${officeId ?? "none"}`;
}
