/**
 * TanStack Query key factory.
 *
 * Every key is scoped by a SCOPE STRING of "userId:officeId", for two independent reasons:
 *   - offices are separate Postgres schemas, so the same id in two offices is two different records; and
 *   - the QueryClient is module-level and signOut does not clear it, so without the user in the key a
 *     second account signing in on the same device can be served the FIRST account's cached rows with no
 *     request at all — including owner-scoped "mine" results and viewer-filtered detail.
 * Build it with `useQueryScope()`; never assemble a key from officeId alone.
 */
export type QueryScope = string;

export const qk = {
  me: () => ["me"] as const,
  offices: () => ["offices"] as const,
  deals: (scope: QueryScope, params?: Record<string, unknown>) =>
    ["deals", scope, params ?? {}] as const,
  deal: (scope: QueryScope, id: string) => ["deal", scope, id] as const,
  contacts: (scope: QueryScope, params?: Record<string, unknown>) =>
    ["contacts", scope, params ?? {}] as const,
  contact: (scope: QueryScope, id: string) => ["contact", scope, id] as const,
  stages: (scope: QueryScope) => ["stages", scope] as const,
  dealActivities: (scope: QueryScope, dealId: string) =>
    ["deal-activities", scope, dealId] as const,
} as const;
